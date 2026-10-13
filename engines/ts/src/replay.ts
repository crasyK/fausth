/**
 * Track A replay host (spec-v0.3 §15.4).
 *
 * One implementation for `fausth replay`, `fausth test` fixture checks and `fausth select`:
 * - recorded proposals from `model.jsonl` (exhausted ⇒ stop);
 * - `tools.jsonl` present (even empty) ⇒ recorded-transcript mode for every invocation;
 * - otherwise world tools come from the reference in-memory world, and user-channel tools only
 *   from `user.jsonl` recorded answers (none ⇒ unbound ⇒ capability_missing). Recorded answers
 *   use the deployment adapter's recorded user channel (same format as `user: {source: recorded}`);
 * - iteration cap 32, no judge.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { FaustRuntime, eventsToJsonl, type ToolHandler } from "./runtime.js";
import { loadAgentDir, parseRecordedProposal, readJsonl } from "./load.js";
import { canonicalJson } from "./canonical.js";
import { validateAgent } from "./validate.js";
import {
  createCodingTools,
  createGreenhouseTools,
  createSpawnTool,
  codingWorldFromAgent,
} from "./tools/world.js";
import { createUserChannelHandler, stateValueType } from "./adapters/user-channel.js";
import type { AgentIR, Deployment, ModelProposal, RecordedToolCall } from "./types.js";

export const TRACK_A_ITERATIONS = 32;
export const FIXTURE_SECRET = "sk-fixture-secret-0001";

/** Drop handlers for user-channel tools: a world stub must never answer for the user (D14). */
export function withoutUserChannelHandlers(
  agent: AgentIR,
  handlers: Record<string, ToolHandler>,
): Record<string, ToolHandler> {
  const user = new Set((agent.tools ?? []).filter((t) => t.channel === "user").map((t) => t.id));
  const out: Record<string, ToolHandler> = {};
  for (const [id, h] of Object.entries(handlers)) if (!user.has(id)) out[id] = h;
  return out;
}

/** Recorded user channel for a fixture's `user.jsonl` (spec-v0.3 §15.2). */
export function fixtureUserChannel(agent: AgentIR, dir: string, answersFile = "user.jsonl"): Record<string, ToolHandler> {
  const out: Record<string, ToolHandler> = {};
  const deployment = { model: { transport: "recorded" }, bindings: {} } as unknown as Deployment;
  for (const tool of agent.tools ?? []) {
    if (tool.channel !== "user") continue;
    const allowSetKeys = (agent.counterbalance?.checkpoints ?? [])
      .filter((c) => c.tool === tool.id)
      .flatMap((c) => c.allow_set_keys);
    const stateTypes = Object.fromEntries(
      allowSetKeys.filter((k) => k in (agent.state ?? {})).map((k) => [k, stateValueType(agent.state[k])]),
    );
    out[tool.id] = createUserChannelHandler(
      tool,
      { source: "recorded", answers: answersFile },
      { baseDir: dir, deployment, allowSetKeys, stateTypes },
    ) as ToolHandler;
  }
  return out;
}

/** Reference in-memory world for Track A fixtures (world-channel tools only). */
export function buildReplayWorld(agent: AgentIR): Record<string, ToolHandler> {
  const files: Record<string, string> = {
    "src/app.ts": "export {}",
    "src/app.js": 'export function greet(){ return "hello"; }\n',
  };
  for (const p of agent.permissions?.secrets?.paths ?? []) {
    if (files[p] === undefined) files[p] = FIXTURE_SECRET;
  }
  for (const p of agent.permissions?.protected_paths ?? []) {
    if (files[p] === undefined) files[p] = 'export function greet(){ return "hello"; }\n';
  }
  const handlers = {
    ...createGreenhouseTools({
      temperature_decidegrees: Number(agent.state?.temperature_decidegrees ?? 250),
      fan_percent: Number(agent.state?.fan_percent ?? 0),
      sensor_healthy: Number(agent.state?.sensor_healthy ?? 1),
    }),
    ...createCodingTools(codingWorldFromAgent(agent, { files })),
    ...createSpawnTool(agent.permissions?.tools ?? []),
  } as Record<string, ToolHandler>;
  return withoutUserChannelHandlers(agent, handlers);
}

export type ReplayResult = { ok: boolean; actual: string; expected: string; name: string };

export async function runFixture(dir: string, agentOverride?: AgentIR): Promise<FaustRuntime> {
  const agent = agentOverride ?? loadAgentDir(dir).agent;
  const proposals: ModelProposal[] = readJsonl(join(dir, "model.jsonl")).map(parseRecordedProposal);
  const transcriptPath = join(dir, "tools.jsonl");
  const transcript = existsSync(transcriptPath)
    ? (readJsonl(transcriptPath) as RecordedToolCall[])
    : undefined;
  let tools = buildReplayWorld(agent);
  if (existsSync(join(dir, "user.jsonl"))) tools = { ...tools, ...fixtureUserChannel(agent, dir) };
  let pi = 0;
  const runtime = new FaustRuntime({
    agent,
    propose: async () => (pi >= proposals.length ? { type: "stop" } : proposals[pi++]!),
    tools,
    ...(transcript !== undefined ? { recordedToolResults: transcript } : {}),
    allowJudge: false,
  });
  await runtime.runLoop(TRACK_A_ITERATIONS);
  return runtime;
}

export async function replayFixtureDir(dir: string, agentOverride?: AgentIR): Promise<ReplayResult> {
  const name = basename(dir);
  const runtime = await runFixture(dir, agentOverride);
  const actual = eventsToJsonl(runtime.events);
  const expected = readFileSync(join(dir, "expected.jsonl"), "utf8").replace(/\r\n/g, "\n");
  return { ok: actual === expected, actual, expected, name };
}

/** Inputs of one conformance fixture (spec-v0.3 §15.4). */
export type FixtureSpec = {
  agent: AgentIR;
  /** Recorded model lines (`model.jsonl`). */
  proposals: unknown[];
  /** Recorded transcript (`tools.jsonl`); omit for none, [] for an empty transcript. */
  transcript?: RecordedToolCall[];
  /** Recorded user answers (`user.jsonl`). */
  user?: unknown[];
  /** Line serialization: canonical JSON (default) or insertion-order JSON. */
  lineStyle?: "canonical" | "json";
};

/**
 * Write a fixture's inputs and derive `expected.jsonl` with the normative replay host
 * (never with a generator-private world). The agent must validate. Returns the event count.
 */
export async function materializeFixture(fixturesRoot: string, name: string, spec: FixtureSpec): Promise<number> {
  const v = validateAgent(spec.agent);
  if (!v.ok) throw new Error(`fixture ${name}: agent does not validate:\n${v.errors.join("\n")}`);
  const dir = join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  for (const f of ["tools.jsonl", "user.jsonl"]) rmSync(join(dir, f), { force: true });
  const line = (x: unknown) => (spec.lineStyle === "json" ? JSON.stringify(x) : canonicalJson(x));
  const lines = (xs: unknown[]) => xs.map(line).join("\n") + (xs.length ? "\n" : "");
  writeFileSync(join(dir, "agent.json"), canonicalJson(spec.agent) + "\n");
  writeFileSync(join(dir, "model.jsonl"), lines(spec.proposals));
  if (spec.transcript !== undefined) writeFileSync(join(dir, "tools.jsonl"), lines(spec.transcript));
  if (spec.user !== undefined) writeFileSync(join(dir, "user.jsonl"), lines(spec.user));
  const runtime = await runFixture(dir);
  writeFileSync(join(dir, "expected.jsonl"), eventsToJsonl(runtime.events));
  return runtime.events.length;
}
