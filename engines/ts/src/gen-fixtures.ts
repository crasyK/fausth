/**
 * Generates golden fixtures from spec-aligned scenarios.
 * Expected logs follow docs/spec-v0.1.md lifecycle rules.
 * Review every expected.jsonl before treating as normative.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { FaustRuntime, eventsToJsonl } from "./runtime.js";
import { agentYamlToIr, loadYamlFile, toCanonicalIrJson } from "./load.js";
import { createGreenhouseTools, createCodingTools, createSpawnTool } from "./tools/world.js";
import type { AgentIR, ModelProposal, RecordedToolCall } from "./types.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function writeFixture(
  name: string,
  agent: AgentIR,
  proposals: ModelProposal[],
  toolsQueue: RecordedToolCall[] | undefined,
  toolFactory: (agent: AgentIR) => Record<string, import("./runtime.js").ToolHandler>,
) {
  const dir = join(root, "conformance/fixtures", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.json"), toCanonicalIrJson(agent));
  writeFileSync(
    join(dir, "model.jsonl"),
    proposals.map((p) => JSON.stringify(p)).join("\n") + "\n",
  );
  if (toolsQueue) {
    writeFileSync(
      join(dir, "tools.jsonl"),
      toolsQueue.map((t) => JSON.stringify(t)).join("\n") + "\n",
    );
  }
  let pi = 0;
  const runtime = new FaustRuntime({
    agent,
    propose: async () => (pi >= proposals.length ? { type: "stop" } : proposals[pi++]!),
    tools: toolFactory(agent),
    recordedToolResults: toolsQueue,
    allowJudge: false,
  });
  await runtime.runLoop();
  writeFileSync(join(dir, "expected.jsonl"), eventsToJsonl(runtime.events));
  console.log("wrote", name, runtime.events.length, "events");
}

async function main() {
  const gh = agentYamlToIr(loadYamlFile(join(root, "examples/greenhouse/agent.yml")));
  const code = agentYamlToIr(loadYamlFile(join(root, "examples/coding/agent.yml")));

  const ghTools = (agent: AgentIR) =>
    createGreenhouseTools({
      temperature_decidegrees: Number(agent.state.temperature_decidegrees ?? 250),
      fan_percent: Number(agent.state.fan_percent ?? 0),
      sensor_healthy: Number(agent.state.sensor_healthy ?? 1),
    });

  const codeTools = (agent: AgentIR) => ({
    ...createCodingTools({
      files: { "src/app.ts": "export {}" },
      write_scopes: agent.permissions?.filesystem?.write_scopes ?? ["src/"],
      last_exit_code: 1,
      out_of_scope_writes: 0,
    }),
    ...createSpawnTool(agent.permissions?.tools ?? []),
  });

  await writeFixture(
    "allow-set-fan",
    gh,
    [{ type: "tool", name: "actuator.fan.set", args: { percent: 40 } }, { type: "stop" }],
    undefined,
    ghTools,
  );

  await writeFixture(
    "deny-fan-over-80",
    gh,
    [{ type: "tool", name: "actuator.fan.set", args: { percent: 90 } }],
    undefined,
    ghTools,
  );

  await writeFixture(
    "deny-unknown-tool",
    gh,
    [{ type: "tool", name: "evil.tool", args: {} }],
    undefined,
    ghTools,
  );

  await writeFixture(
    "verify-effect-mismatch",
    gh,
    [{ type: "tool", name: "actuator.fan.set", args: { percent: 40 } }],
    [
      {
        call_seq: 1,
        tool: "actuator.fan.set",
        args: { percent: 40 },
        result: { output: { ok: 1, percent: 40 } },
      },
      {
        call_seq: 2,
        tool: "sensor.fan.read_percent",
        args: {},
        result: { output: { percent: 0 } },
      },
      {
        call_seq: 3,
        tool: "actuator.fan.set",
        args: { percent: 0 },
        result: {
          output: { ok: 1, percent: 0 },
          state_transition: { set: { fan_percent: 0 } },
        },
      },
      {
        call_seq: 4,
        tool: "sensor.fan.read_percent",
        args: {},
        result: { output: { percent: 0 } },
      },
    ],
    ghTools,
  );

  await writeFixture(
    "verify-absence-violation",
    code,
    [{ type: "tool", name: "fs.write_scoped", args: { path: "secrets/key.txt", content: "x" } }],
    undefined,
    codeTools,
  );

  await writeFixture(
    "code-verify-tests-fail",
    code,
    [{ type: "tool", name: "shell.run_allowlisted", args: { cmd: "test" } }],
    undefined,
    codeTools,
  );

  const budgetAgent: AgentIR = {
    ...gh,
    limits: { max_steps: 6, max_tool_calls: 0 },
  };
  await writeFixture(
    "budget-exceed",
    budgetAgent,
    [{ type: "tool", name: "actuator.fan.set", args: { percent: 10 } }],
    undefined,
    ghTools,
  );

  await writeFixture(
    "spawn-ok",
    code,
    [{ type: "tool", name: "agent.spawn", args: { tools: ["fs.read"] } }, { type: "stop" }],
    undefined,
    codeTools,
  );

  await writeFixture(
    "spawn-deny-escalate",
    code,
    [{ type: "tool", name: "agent.spawn", args: { tools: ["fs.read", "shell.unrestricted"] } }],
    undefined,
    codeTools,
  );

  // spawn.allow false
  const spawnDisabled: AgentIR = {
    ...code,
    spawn: { allow: false, tighten_only: true },
  };
  await writeFixture(
    "spawn-deny-when-disabled",
    spawnDisabled,
    [{ type: "tool", name: "agent.spawn", args: { tools: ["fs.read"] } }],
    undefined,
    codeTools,
  );

  // filesystem escalation
  await writeFixture(
    "spawn-deny-fs-escalate",
    code,
    [
      {
        type: "tool",
        name: "agent.spawn",
        args: {
          tools: ["fs.read"],
          filesystem: { write_scopes: ["/"] },
        },
      },
    ],
    undefined,
    codeTools,
  );

  // input schema invalid
  await writeFixture(
    "input-schema-invalid",
    gh,
    [{ type: "tool", name: "actuator.fan.set", args: { percent: "maximum please" } as Record<string, unknown> }],
    undefined,
    ghTools,
  );

  // predicate missing path via gate that uses neq on missing — use a custom agent
  const missingAgent: AgentIR = {
    ...gh,
    gates: [
      {
        id: "require-flag",
        when: { path: "action.name", eq: "system.wait" },
        require: { path: "action.args.flag", eq: 1 },
        otherwise: "deny",
      },
      ...(gh.gates ?? []),
    ],
  };
  await writeFixture(
    "predicate-missing-path",
    missingAgent,
    [{ type: "tool", name: "system.wait", args: { ms: 0 } }],
    undefined,
    ghTools,
  );
}

main();
