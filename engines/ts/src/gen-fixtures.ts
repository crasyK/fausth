/**
 * Generates the greenhouse / coding / spawn golden fixtures.
 *
 * Inputs (agent.json, model.jsonl, tools.jsonl) are written here; expected.jsonl is derived by
 * the normative Track A replay host (replay.ts) and must agree with docs/spec-v0.3.md.
 * Review every changed expected.jsonl before committing it.
 */
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentYamlToIr, loadYamlFile } from "./load.js";
import { materializeFixture } from "./replay.js";
import type { AgentIR, ModelProposal, RecordedToolCall } from "./types.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixturesRoot = join(root, "conformance/fixtures");

async function writeFixture(
  name: string,
  agent: AgentIR,
  proposals: ModelProposal[],
  transcript?: RecordedToolCall[],
): Promise<void> {
  const n = await materializeFixture(fixturesRoot, name, { agent, proposals, transcript, lineStyle: "json" });
  console.log("wrote", name, n, "events");
}

async function main(): Promise<void> {
  const gh = agentYamlToIr(loadYamlFile(join(root, "examples/greenhouse/agent.yml")));
  const code = agentYamlToIr(loadYamlFile(join(root, "examples/coding/agent.yml")));

  await writeFixture("allow-set-fan", gh, [
    { type: "tool", name: "actuator.fan.set", args: { percent: 40 } },
    { type: "stop" },
  ]);

  await writeFixture("deny-fan-over-80", gh, [{ type: "tool", name: "actuator.fan.set", args: { percent: 90 } }]);

  await writeFixture("deny-unknown-tool", gh, [{ type: "tool", name: "evil.tool", args: {} }]);

  // Effect mismatch → safe_state → recovery through the normal path (D10): the recovery
  // action's own effect verify observes once, recovery.verify observes again.
  await writeFixture(
    "verify-effect-mismatch",
    gh,
    [{ type: "tool", name: "actuator.fan.set", args: { percent: 40 } }],
    [
      { call_seq: 1, tool: "actuator.fan.set", args: { percent: 40 }, result: { output: { ok: 1, percent: 40 } } },
      { call_seq: 2, tool: "sensor.fan.read_percent", args: {}, result: { output: { percent: 0 } } },
      {
        call_seq: 3,
        tool: "actuator.fan.set",
        args: { percent: 0 },
        result: { output: { ok: 1, percent: 0 }, state_transition: { set: { fan_percent: 0 } } },
      },
      { call_seq: 4, tool: "sensor.fan.read_percent", args: {}, result: { output: { percent: 0 } } },
      { call_seq: 5, tool: "sensor.fan.read_percent", args: {}, result: { output: { percent: 0 } } },
    ],
  );

  await writeFixture("verify-absence-violation", code, [
    { type: "tool", name: "fs.write_scoped", args: { path: "secrets/key.txt", content: "x" } },
  ]);

  await writeFixture("code-verify-tests-fail", code, [
    { type: "tool", name: "shell.run_allowlisted", args: { cmd: "test" } },
  ]);

  await writeFixture("budget-exceed", { ...gh, limits: { max_steps: 6, max_tool_calls: 0 } }, [
    { type: "tool", name: "actuator.fan.set", args: { percent: 10 } },
  ]);

  await writeFixture("spawn-ok", code, [
    { type: "tool", name: "agent.spawn", args: { tools: ["fs.read"] } },
    { type: "stop" },
  ]);

  await writeFixture("spawn-deny-escalate", code, [
    { type: "tool", name: "agent.spawn", args: { tools: ["fs.read", "shell.unrestricted"] } },
  ]);

  await writeFixture("spawn-deny-when-disabled", { ...code, spawn: { allow: false, tighten_only: true } }, [
    { type: "tool", name: "agent.spawn", args: { tools: ["fs.read"] } },
  ]);

  // An absolute child scope is malformed (D7): schema_invalid, never "covered".
  await writeFixture("spawn-deny-fs-escalate", code, [
    { type: "tool", name: "agent.spawn", args: { tools: ["fs.read"], filesystem: { write_scopes: ["/"] } } },
  ]);

  await writeFixture("spawn-nested-deny", code, [
    { type: "tool", name: "agent.spawn", args: { tools: ["fs.read"], spawn_nested: true } },
  ]);

  // Nested child reaction: child events appear in the parent log; the child is charged to the parent.
  const nestedOk: AgentIR = { ...code, spawn: { allow: true, allow_nested: true, tighten_only: true } };
  await writeFixture("spawn-nested-ok", nestedOk, [
    {
      type: "tool",
      name: "agent.spawn",
      args: {
        tools: ["fs.read"],
        proposals: [{ type: "tool", name: "fs.read", args: { path: "src/app.ts" } }, { type: "stop" }],
      },
    },
    { type: "stop" },
  ]);

  // Child proposes a tool outside its envelope → deny visible in the parent log.
  await writeFixture("spawn-child-escalate-deny", nestedOk, [
    {
      type: "tool",
      name: "agent.spawn",
      args: {
        tools: ["fs.read"],
        proposals: [{ type: "tool", name: "fs.write_scoped", args: { path: "src/app.ts", content: "x" } }],
      },
    },
  ]);

  await writeFixture("input-schema-invalid", gh, [
    { type: "tool", name: "actuator.fan.set", args: { percent: "maximum please" } as Record<string, unknown> },
  ]);

  // MISSING path in a gate require → deny.
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
  await writeFixture("predicate-missing-path", missingAgent, [{ type: "tool", name: "system.wait", args: { ms: 0 } }]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
