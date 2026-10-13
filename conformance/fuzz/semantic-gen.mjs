/**
 * Hand-written semantic cases with EXPECTED verdicts (not just TS ↔ PY agreement).
 * Each case is checked against both engines by `node scripts/fuzz-ir.mjs semantic`.
 * Regenerate the JSON files with `node conformance/fuzz/semantic-gen.mjs`.
 */
import { mkdirSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "semantic");

const OBJ = { type: "object", additionalProperties: true };
const agent = (tools, extra = {}) => ({
  spec: "counterbalance-contract/v0.1",
  name: "semantic",
  state: {},
  tools: tools.map((t) => (typeof t === "string" ? { id: t, input: OBJ } : { input: OBJ, ...t })),
  ...extra,
});
const call = (name, args = {}) => ({ type: "tool", name, args });

const cases = [
  // --- PY-1 / D4: YAML 1.2 core schema --------------------------------------------
  { id: "py1-yaml-on-key", finding: "PY-1", decision: "D4", kind: "yaml",
    text: "recovery:\n  on: verify_effect_failed\n", expect: { out: '{"recovery":{"on":"verify_effect_failed"}}' } },
  { id: "py1-yaml-yes-no-strings", finding: "PY-1", decision: "D4", kind: "yaml",
    text: "a: yes\nb: on\nc: off\nd: No\n", expect: { out: '{"a":"yes","b":"on","c":"off","d":"No"}' } },
  { id: "py1-yaml-numbers", finding: "PY-1", decision: "D4", kind: "yaml",
    text: "a: 010\nb: 0o10\nc: 1.0\nd: 1e3\ne: 1:20\nf: 2001-12-14\n",
    expect: { out: '{"a":10,"b":8,"c":1,"d":1000,"e":"1:20","f":"2001-12-14"}' } },
  // --- PY-2 / D5: permissions.tools [] = none ---------------------------------------
  { id: "py2-empty-permissions-deny", finding: "PY-2", decision: "D5", kind: "run",
    agent: agent(["echo.ping"], { permissions: { tools: [] } }), model_lines: [call("echo.ping")],
    expect: { contains: [{ stage: "validate", verdict: "deny", reason: "capability_missing", tool: "echo.ping" }],
              absent: [{ stage: "execute" }] } },
  { id: "py2-absent-permissions-allow", finding: "PY-2", decision: "D5", kind: "run",
    agent: agent(["echo.ping"]), model_lines: [call("echo.ping")],
    expect: { contains: [{ stage: "execute", verdict: "allow", tool: "echo.ping" }] } },
  // --- PY-12 / D3: integral numbers are integers -------------------------------------
  { id: "py12-canonical-integral-floats", finding: "PY-12", decision: "D3", kind: "canonical",
    json_text: '{"a":1.0,"b":1e3,"c":-0.0}', expect: { out: '{"a":1,"b":1000,"c":0}' } },
  { id: "py12-canonical-non-integral", finding: "PY-12", decision: "D3", kind: "canonical",
    json_text: '{"x":1.5}', expect: { error: true } },
  { id: "py12-recorded-result-integral-float", finding: "PY-12", decision: "D3", kind: "run",
    agent: agent(["echo.ping"]), model_lines: [call("echo.ping")],
    tools: [{ call_seq: 1, tool: "echo.ping", args: {}, result: { output: { n: 1.0 } } }],
    expect: { contains: [{ stage: "execute", verdict: "allow", result: { n: 1 } }] } },
  { id: "d3-non-integral-output-denied", decision: "D3", kind: "run",
    agent: agent(["echo.ping"]), model_lines: [call("echo.ping")],
    tools: [{ call_seq: 1, tool: "echo.ping", args: {}, result: { output: { n: 1.5 } } }],
    expect: { contains: [{ stage: "execute", verdict: "deny", reason: "output_schema_invalid" }] } },
  // --- PY-16 / D6: spawn ------------------------------------------------------------
  { id: "py16-spawn-allow-null-denied", finding: "PY-16", decision: "D6", kind: "run",
    agent: agent(["agent.spawn", "fs.read"], { spawn: { allow: null } }), model_lines: [call("agent.spawn", { tools: ["fs.read"] })],
    expect: { contains: [{ stage: "authorize", verdict: "deny", reason: "gate_denied", tool: "agent.spawn" }],
              absent: [{ stage: "execute", tool: "agent.spawn" }] } },
  { id: "d6-spawn-policy-missing-denied", decision: "D6", kind: "run",
    agent: agent(["agent.spawn", "fs.read"]), model_lines: [call("agent.spawn", { tools: ["fs.read"] })],
    expect: { contains: [{ stage: "authorize", verdict: "deny", reason: "gate_denied" }], absent: [{ stage: "execute" }] } },
  { id: "d6-spawn-needs-permission", decision: "D6", kind: "run",
    agent: agent(["agent.spawn", "fs.read"], { spawn: { allow: true }, permissions: { tools: ["fs.read"] } }),
    model_lines: [call("agent.spawn", { tools: ["fs.read"] })],
    expect: { contains: [{ stage: "validate", verdict: "deny", reason: "capability_missing", tool: "agent.spawn" }] } },
  // --- PY-17 / D7: scope normalization -------------------------------------------------
  { id: "py17-child-src-under-parent-src-slash", finding: "PY-17", decision: "D7", kind: "run",
    agent: agent(["agent.spawn", "fs.read"], { spawn: { allow: true }, permissions: { filesystem: { write_scopes: ["src/"] } } }),
    model_lines: [call("agent.spawn", { tools: ["fs.read"], filesystem: { write_scopes: ["src"] } })],
    expect: { contains: [{ stage: "execute", verdict: "allow", tool: "agent.spawn" }] } },
  { id: "py17-child-src-slash-under-parent-src", finding: "PY-17", decision: "D7", kind: "run",
    agent: agent(["agent.spawn", "fs.read"], { spawn: { allow: true }, permissions: { filesystem: { write_scopes: ["src"] } } }),
    model_lines: [call("agent.spawn", { tools: ["fs.read"], filesystem: { write_scopes: ["src/"] } })],
    expect: { contains: [{ stage: "execute", verdict: "allow", tool: "agent.spawn" }] } },
  { id: "py17-dotdot-escape-denied", finding: "PY-17", decision: "D7", kind: "run",
    agent: agent(["agent.spawn", "fs.read"], { spawn: { allow: true }, permissions: { filesystem: { write_scopes: ["src/"] } } }),
    model_lines: [call("agent.spawn", { tools: ["fs.read"], filesystem: { write_scopes: ["src/../etc"] } })],
    expect: { contains: [{ stage: "authorize", verdict: "deny", reason: "gate_denied", error: "write_scopes escalation" }] } },
  // --- SPEC-16: undeclared permission ---------------------------------------------------
  { id: "spec16-undeclared-permission-invalid", finding: "SPEC-16", kind: "validate",
    agent: { spec: "counterbalance-contract/v0.1", name: "x", state: {}, tools: [{ id: "fs.read" }], permissions: { tools: ["fs.read", "shell.unrestricted"] } },
    expect: { ok: false } },
  // --- D8: success = executed AND verified ---------------------------------------------------
  { id: "d8-verify-failure-discards-transition", decision: "D8", kind: "run",
    agent: agent([{ id: "fs.write_scoped", verify: [{ kind: "absence", require: { path: "result.out_of_scope", eq: 0 }, otherwise: "deny" }] }],
      { state: { out_of_scope_writes: 0 }, permissions: { filesystem: { write_scopes: ["src/"] } } }),
    model_lines: [call("fs.write_scoped", { path: "docs/x.md", content: "x" })],
    expect: { contains: [{ stage: "verify", reason: "verify_absence_failed", failure: { kind: "transition_discarded", keys: ["out_of_scope_writes"] } }] } },
  // --- D9: checkpoint authority before execution -------------------------------------------------
  { id: "d9-checkpoint-at-authorize", decision: "D9", kind: "run",
    agent: agent(["user.correct"], { state: { open_todos: 1, plan_approved: 0 }, counterbalance: { checkpoints: [{ tool: "user.correct", allow_set_keys: ["open_todos"] }] } }),
    model_lines: [call("user.correct", { set: { plan_approved: 1 } })],
    expect: { contains: [{ stage: "authorize", verdict: "deny", reason: "checkpoint_authority_failed" }], absent: [{ stage: "execute" }] } },
  // --- D10: recovery takes the governed path ---------------------------------------------------------
  { id: "d10-recovery-respects-permissions", decision: "D10", finding: "PY-15", kind: "run",
    agent: agent([
      { id: "sensor.fan.read_percent", read_only: true },
      { id: "actuator.fan.set", verify: [{ kind: "effect", observe: "sensor.fan.read_percent", require: { path: "observation.percent", eq: 99 } }] },
    ], {
      state: { fan_percent: 0 },
      permissions: { tools: ["sensor.fan.read_percent", "actuator.fan.set"] },
      recovery: { execute: { tool: "actuator.fan.set", args: { percent: 0 } }, verify: { kind: "effect", observe: "sensor.fan.read_percent", require: { path: "observation.percent", eq: 0 } } },
      gates: [{ when: { path: "action.args.percent", eq: 0 }, require: { path: "state.fan_percent", eq: 999 } }],
    }),
    model_lines: [call("actuator.fan.set", { percent: 40 })],
    expect: { contains: [{ stage: "authorize", verdict: "deny", reason: "gate_denied", tool: "actuator.fan.set", args: { percent: 0 } }, { stage: "record", reason: "terminal_failure" }],
              absent: [{ reason: "recovery_succeeded" }] } },
  // --- D11: no harness-specific names -------------------------------------------------------------
  { id: "d11-no-plan-block", decision: "D11", finding: "PY-8", kind: "run",
    agent: agent(["user.approve"], { state: { plan_approved: 1 }, counterbalance: { orientation: { emit_each_step: true } } }),
    model_lines: [], expect: { absent_paths: [{ match: { stage: "orient" }, path: "observation.plan" }, { match: { stage: "orient" }, path: "observation.completion" }] } },
  { id: "d11-completion-require-without-tool", decision: "D11", finding: "PY-8", kind: "run",
    agent: agent(["task.complete"], { state: { x: 0 }, counterbalance: { completion: { require: { path: "state.x", eq: 1 } } } }),
    model_lines: [call("task.complete")],
    expect: { contains: [{ stage: "execute", verdict: "allow", tool: "task.complete" }], absent: [{ reason: "completion_gate_failed" }] } },
  // --- PY-7: memory_stale once per staleness transition ----------------------------------------------
  { id: "py7-ttl-stale-once", finding: "PY-7", kind: "run",
    agent: agent(["echo.ping"], { state: { evidence: 1 }, limits: { continue_after_deny: true }, counterbalance: { invalidate_after: [{ ttl_steps: 1, memory_keys: ["evidence"] }] } }),
    model_lines: [call("echo.ping"), call("echo.ping"), call("echo.ping"), call("echo.ping")],
    expect: { count: [{ match: { reason: "memory_stale" }, n: 1 }] } },
  // --- D14: user cell -------------------------------------------------------------------------------
  { id: "d14-unbound-user-channel", decision: "D14", kind: "run",
    agent: agent([{ id: "user.approve", channel: "user" }]), model_lines: [call("user.approve", { plan: "p" })],
    expect: { contains: [{ stage: "validate", verdict: "deny", reason: "capability_missing", tool: "user.approve" }], absent: [{ stage: "execute" }] } },
  // --- D2: code points --------------------------------------------------------------------------------
  { id: "d2-kb-lookup-code-points", decision: "D2", kind: "run",
    agent: agent(["kb.lookup"]), model_lines: [call("kb.lookup", { query: "\u{1F600}".repeat(30) })],
    expect: { contains: [{ stage: "execute", result: { ok: 1, article_id: "kb-" + "\u{1F600}".repeat(24) } }] } },
  { id: "d2-message-length-code-points", decision: "D2", kind: "run",
    agent: agent([{ id: "answer.send", verify: [{ kind: "output", require: { path: "message.length", lte: 3 } }] }]),
    model_lines: [call("answer.send", { message: "\u{1F600}\u{1F680}\u{1F600}" })],
    expect: { contains: [{ stage: "verify", verdict: "allow", tool: "answer.send" }] } },
  // --- D1: key order by code point ---------------------------------------------------------------------
  { id: "d1-astral-key-order", decision: "D1", kind: "canonical",
    json_text: '{"\\ud83d\\ude00":1,"\\uff01":2}', expect: { out: '{"！":2,"\u{1F600}":1}' } },
  { id: "d1-integer-like-key-order", decision: "D1", kind: "canonical",
    json_text: '{"9":1,"10":2}', expect: { out: '{"10":2,"9":1}' } },
  // --- D16: own keys only -------------------------------------------------------------------------------
  { id: "d16-no-array-length", decision: "D16", kind: "run",
    agent: agent(["echo.ping"], { gates: [{ require: { path: "action.args.items.length", eq: 2 } }] }),
    model_lines: [call("echo.ping", { items: [1, 2] })],
    expect: { contains: [{ stage: "authorize", verdict: "deny", reason: "gate_denied" }] } },
  // --- PY-6: invalid proposals ---------------------------------------------------------------------------
  { id: "py6-invalid-proposal", finding: "PY-6", kind: "run", raw_proposals: true,
    agent: agent(["echo.ping"]), model_lines: [{ type: "invalid", reason: "no_tool_call", message: "hmm" }],
    expect: { contains: [{ stage: "propose", verdict: "deny", reason: "empty_proposal", observation: { invalid_reason: "no_tool_call", stop_message: "hmm" } }] } },
  { id: "py6-tool-alias", finding: "PY-6", kind: "run",
    agent: agent(["echo.ping"]), model_lines: [{ type: "tool", tool: "echo.ping" }],
    expect: { contains: [{ stage: "execute", verdict: "allow", tool: "echo.ping" }] } },
];

mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) if (f.endsWith(".json")) unlinkSync(join(outDir, f));
for (const c of cases) {
  const req = { world: "replay", ...c };
  writeFileSync(join(outDir, `${c.id}.json`), JSON.stringify(req, null, 2) + "\n");
}
console.log(`wrote ${cases.length} semantic cases → ${outDir}`);
