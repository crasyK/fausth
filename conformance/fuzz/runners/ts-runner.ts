/**
 * Cross-engine parity runner (TypeScript side).
 *
 * Reads JSON Lines requests on stdin, writes one JSON result line per request.
 * The Python twin is `py_runner.py`; `scripts/parity.mjs` and
 * `scripts/fuzz-ir.mjs` diff the two outputs byte-for-byte.
 *
 * Request kinds:
 *   run        {agent, model_lines, tools?, world: "replay"|"simulation", max_steps?}
 *   canonical  {json_text}
 *   yaml       {text}
 *   validate   {agent}
 *   schema     {schema, data}           (tool I/O schema validation, ajv + ajv-formats)
 *   agent_yaml {text}
 *   world      {agent, world, calls: [{tool, args}]}
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { FaustRuntime, eventsToJsonl } from "../../../engines/ts/src/runtime.js";
import { canonicalJson } from "../../../engines/ts/src/canonical.js";
import { parseRecordedModelLine } from "../../../engines/ts/src/adapters/recorded.js";
import { resolveToolsFromDeployment, NATIVE_TO_TOOL } from "../../../engines/ts/src/adapters/registry.js";
import { agentYamlToIr } from "../../../engines/ts/src/load.js";
import { validateAgent } from "../../../engines/ts/src/validate.js";
import { validateAgainstSchema } from "../../../engines/ts/src/schema-validate.js";
import {
  codingWorldFromAgent,
  createCodingTools,
  createGreenhouseTools,
  createSpawnTool,
} from "../../../engines/ts/src/tools/world.js";
import type { AgentIR, Deployment, ModelProposal, RecordedToolCall } from "../../../engines/ts/src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const require = createRequire(join(root, "engines/ts/package.json"));
const { parse: parseYaml } = require("yaml") as { parse: (s: string) => unknown };

// --- replay world: a verbatim copy of cli.ts `buildTools` (guarded below) ---------
const BUILD_TOOLS_SOURCE = `function buildTools(agent: AgentIR, overrides?: { testExit?: number; sensorHealthy?: number }) {
  const files: Record<string, string> = {
    "src/app.ts": "export {}",
    "src/app.js": 'export function greet(){ return "hello"; }\\n',
  };
  const secrets = agent.permissions?.secrets;
  if (secrets?.paths) {
    for (const p of secrets.paths) {
      if (files[p] === undefined) files[p] = "sk-fixture-secret-0001";
    }
  }
  for (const p of agent.permissions?.protected_paths ?? []) {
    if (files[p] === undefined) {
      files[p] = 'export function greet(){ return "hello"; }\\n';
    }
  }
  return {
    ...createGreenhouseTools({
      temperature_decidegrees: Number(agent.state.temperature_decidegrees ?? 250),
      fan_percent: Number(agent.state.fan_percent ?? 0),
      sensor_healthy: overrides?.sensorHealthy ?? Number(agent.state.sensor_healthy ?? 1),
    }),
    ...createCodingTools(codingWorldFromAgent(agent, { testExit: overrides?.testExit, files })),
    ...createSpawnTool(agent.permissions?.tools ?? []),
  };
}`;

function assertBuildToolsInSync(): void {
  const cli = readFileSync(join(root, "engines/ts/src/cli.ts"), "utf8").replace(/\r\n/g, "\n");
  if (!cli.includes(BUILD_TOOLS_SOURCE)) {
    throw new Error(
      "ts-runner: engines/ts/src/cli.ts buildTools() changed — update BUILD_TOOLS_SOURCE / replayTools in conformance/fuzz/runners/ts-runner.ts",
    );
  }
}

function replayTools(agent: AgentIR, overrides?: { testExit?: number; sensorHealthy?: number }) {
  const files: Record<string, string> = {
    "src/app.ts": "export {}",
    "src/app.js": 'export function greet(){ return "hello"; }\n',
  };
  const secrets = agent.permissions?.secrets;
  if (secrets?.paths) {
    for (const p of secrets.paths) {
      if (files[p] === undefined) files[p] = "sk-fixture-secret-0001";
    }
  }
  for (const p of agent.permissions?.protected_paths ?? []) {
    if (files[p] === undefined) {
      files[p] = 'export function greet(){ return "hello"; }\n';
    }
  }
  return {
    ...createGreenhouseTools({
      temperature_decidegrees: Number(agent.state.temperature_decidegrees ?? 250),
      fan_percent: Number(agent.state.fan_percent ?? 0),
      sensor_healthy: overrides?.sensorHealthy ?? Number(agent.state.sensor_healthy ?? 1),
    }),
    ...createCodingTools(codingWorldFromAgent(agent, { testExit: overrides?.testExit, files })),
    ...createSpawnTool(agent.permissions?.tools ?? []),
  };
}

/** Deployment pool (registry buildHandlerPool) via an identity binding for every known tool. */
function simulationTools(agent: AgentIR) {
  const bindings: Deployment["bindings"] = {};
  for (const t of agent.tools ?? []) {
    if (typeof t?.id === "string" && NATIVE_TO_TOOL[t.id] === t.id) bindings[t.id] = { native: t.id };
  }
  return resolveToolsFromDeployment(agent, { model: { transport: "recorded" }, bindings } as Deployment);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function handle(req: Record<string, unknown>): Promise<Record<string, unknown>> {
  const kind = req.kind;
  if (kind === "canonical") {
    return { out: canonicalJson(JSON.parse(String(req.json_text))) };
  }
  if (kind === "yaml") {
    return { out: canonicalJson(parseYaml(String(req.text)) ?? null) };
  }
  if (kind === "agent_yaml") {
    return { out: canonicalJson(agentYamlToIr(parseYaml(String(req.text)))) };
  }
  if (kind === "schema") {
    const r = validateAgainstSchema(req.schema as Record<string, unknown> | undefined, req.data);
    return { out: r.ok ? "valid" : "invalid" };
  }
  if (kind === "validate") {
    const r = validateAgent(req.agent as AgentIR);
    return { out: canonicalJson({ ok: r.ok, warnings: r.warnings }) };
  }
  if (kind === "world") {
    const agent = req.agent as AgentIR;
    const tools: Record<string, (a: Record<string, unknown>, c: { state: Record<string, unknown> }) => unknown> =
      req.world === "simulation" ? simulationTools(agent) : replayTools(agent);
    const outs: unknown[] = [];
    for (const call of (req.calls as { tool: string; args: Record<string, unknown> }[]) ?? []) {
      const h = tools[call.tool];
      if (!h) {
        outs.push({ missing: call.tool });
        continue;
      }
      try {
        // JSON round-trip: compare what a JSON transport would carry (drops undefined keys).
        outs.push({ envelope: JSON.parse(JSON.stringify(await h(call.args, { state: agent.state }))) });
      } catch (e) {
        outs.push({ error: errText(e) });
      }
    }
    return { out: canonicalJson(outs) };
  }
  if (kind === "run") {
    const agent = req.agent as AgentIR;
    const lines = (req.model_lines as unknown[]) ?? [];
    const proposals: ModelProposal[] = req.raw_proposals === true
      ? (lines as ModelProposal[])
      : lines.map(parseRecordedModelLine);
    const recorded = (req.tools as RecordedToolCall[] | undefined) ?? [];
    let pi = 0;
    const runtime = new FaustRuntime({
      agent,
      propose: async () => (pi >= proposals.length ? { type: "stop" } : proposals[pi++]!),
      tools: req.world === "simulation" ? simulationTools(agent) : replayTools(agent),
      recordedToolResults: recorded.length ? recorded : undefined,
      allowJudge: false,
    });
    await runtime.runLoop(typeof req.max_steps === "number" ? req.max_steps : 32);
    return { out: eventsToJsonl(runtime.events) };
  }
  throw new Error(`unknown request kind ${String(kind)}`);
}

async function main(): Promise<void> {
  assertBuildToolsInSync();
  const input = readFileSync(0, "utf8");
  const out: string[] = [];
  for (const line of input.split("\n")) {
    if (!line.trim()) continue;
    const req = JSON.parse(line) as Record<string, unknown>;
    let res: Record<string, unknown>;
    try {
      res = { id: req.id, ok: true, ...(await handle(req)) };
    } catch (e) {
      res = { id: req.id, ok: false, error: errText(e) };
    }
    out.push(JSON.stringify(res));
  }
  process.stdout.write(out.join("\n") + (out.length ? "\n" : ""));
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
