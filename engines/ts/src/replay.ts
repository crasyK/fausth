/**
 * Track A replay host (spec-v0.3 §15.4).
 *
 * One implementation for `fausth replay`, `fausth test` fixture checks and `fausth select`:
 * - recorded proposals from `model.jsonl` (exhausted ⇒ stop);
 * - `tools.jsonl` present (even empty) ⇒ recorded-transcript mode for every invocation;
 * - otherwise world tools come from the reference in-memory world, and user-channel tools only
 *   from `user.jsonl` recorded answers (none ⇒ unbound ⇒ capability_missing);
 * - iteration cap 32, no judge.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { FaustRuntime, eventsToJsonl, type ToolHandler } from "./runtime.js";
import { loadAgentDir, parseRecordedProposal, readJsonl } from "./load.js";
import {
  createCodingTools,
  createGreenhouseTools,
  createSpawnTool,
  codingWorldFromAgent,
} from "./tools/world.js";
import {
  loadRecordedUserAnswers,
  recordedUserChannel,
  userChannelToolIds,
  withoutUserChannelHandlers,
} from "./user-channel.js";
import type { AgentIR, ModelProposal, RecordedToolCall } from "./types.js";

export const TRACK_A_ITERATIONS = 32;
export const FIXTURE_SECRET = "sk-fixture-secret-0001";

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
  const userPath = join(dir, "user.jsonl");
  if (existsSync(userPath)) {
    tools = { ...tools, ...recordedUserChannel(loadRecordedUserAnswers(userPath), userChannelToolIds(agent)) };
  }
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
