/**
 * Track A fixtures for the executable contract (docs/spec-v0.3.md):
 * - formerly hand-written fixtures (chat output verifies, budgets, TTL, protected paths, secrets),
 *   now reproducible;
 * - `v03-*` coverage fixtures for every normative rule that had none (SPEC-10) and for the
 *   behaviour changes of D3/D6/D7/D8/D9/D10/D14/D16.
 *
 * Inputs are written here; expected.jsonl is derived by the normative replay host and must agree
 * with the spec text. Review every changed expected.jsonl before committing it.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { materializeFixture, type FixtureSpec } from "./replay.js";
import type { AgentIR, Predicate, RecordedToolCall, ToolDef } from "./types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixturesRoot = join(root, "conformance/fixtures");

const OBJ = (properties: Record<string, unknown> = {}, required: string[] = [], open = false) => ({
  type: "object",
  ...(required.length ? { required } : {}),
  additionalProperties: open,
  properties,
});
const INT = { type: "integer" };
const STR = { type: "string" };

const ping: ToolDef = { id: "noop.ping", input: OBJ(), output: OBJ({ ok: INT }, ["ok"]) };

function agent(name: string, over: Partial<AgentIR>): AgentIR {
  return { spec: "counterbalance-contract/v0.3", name, state: {}, tools: [], ...over };
}

const call = (name: string, args: Record<string, unknown> = {}) => ({ type: "tool", name, args });
const rec = (call_seq: number, tool: string, args: Record<string, unknown>, result: unknown): RecordedToolCall =>
  ({ call_seq, tool, args, result }) as RecordedToolCall;

async function fixture(name: string, spec: FixtureSpec): Promise<void> {
  const n = await materializeFixture(fixturesRoot, name, spec);
  console.log("wrote", name, n, "events");
}

// ---------------------------------------------------------------- formerly hand-written

const teacherReply: ToolDef = {
  id: "teacher.reply",
  input: OBJ({ message: STR }, ["message"]),
  output: OBJ({ ok: INT }, ["ok"]),
  verify: [{ kind: "output", require: { path: "message.contains_code_fence", eq: 0 }, otherwise: "deny" }],
};

const writeTool = (extraOutput: Record<string, unknown>, extraVerify: Predicate[]): ToolDef => ({
  id: "fs.write_scoped",
  input: OBJ({ path: STR, content: STR }, ["path"]),
  output: OBJ({ ok: INT, out_of_scope: INT, path: STR, ...extraOutput }, ["ok", "out_of_scope", "path"]),
  verify: [
    { kind: "absence", require: { path: "result.out_of_scope", eq: 0 }, otherwise: "safe_state" },
    ...extraVerify.map((require) => ({ kind: "absence" as const, require, otherwise: "safe_state" as const })),
  ],
});
const fsRead: ToolDef = {
  id: "fs.read",
  read_only: true,
  input: OBJ({ path: STR }, ["path"]),
  output: OBJ({ path: STR, content: STR, found: INT }, ["path", "found"], true),
};
const taskComplete: ToolDef = { id: "task.complete", input: OBJ(), output: OBJ({ ok: INT }, ["ok"]) };

function guardedCoding(name: string, permissions: AgentIR["permissions"], tools: ToolDef[]): AgentIR {
  return agent(name, {
    spec: "counterbalance-contract/v0.1",
    state: { open_todos: 0, out_of_scope_writes: 0, plan_approved: 1, researched: 1, test_evidence_current: 1 },
    tools,
    limits: { continue_after_deny: true, max_steps: 8, max_tool_calls: 6 },
    fallback_state: { open_todos: 1 },
    permissions,
    counterbalance: {
      completion: {
        tool: "task.complete",
        require: {
          all: [
            { path: "state.test_evidence_current", eq: 1 },
            { path: "state.open_todos", eq: 0 },
          ],
        },
      },
      orientation: { emit_each_step: true },
    },
  });
}

async function formerlyHandWritten(): Promise<void> {
  const chat = (name: string) =>
    agent(name, {
      spec: "counterbalance-contract/v0.1",
      state: { session_open: 1 },
      tools: [teacherReply],
      limits: { max_steps: 8, max_tool_calls: 8 },
      permissions: { tools: ["teacher.reply"] },
    });
  const okMsg = "What would change if this were a recursive function instead of a loop?";
  await fixture("cb-chat-absence-ok", {
    agent: chat("teacher-chat-output-ok"),
    proposals: [call("teacher.reply", { message: okMsg })],
    transcript: [rec(1, "teacher.reply", { message: okMsg }, { ok: 1 })],
  });
  const fenced = "Try a recursive approach:\n```ts\nfunction fact(n){return n<2?1:n*fact(n-1)}\n```";
  await fixture("cb-chat-solution-absence-denied", {
    agent: chat("teacher-chat-output-deny"),
    proposals: [call("teacher.reply", { message: fenced })],
    transcript: [rec(1, "teacher.reply", { message: fenced }, { ok: 1 })],
  });

  await fixture("cb-budget-exceeded", {
    agent: agent("intervention-budget-run", {
      spec: "counterbalance-contract/v0.1",
      state: { ok: 1 },
      tools: [ping],
      limits: { max_steps: 8, max_tool_calls: 8 },
      permissions: { tools: ["noop.ping"] },
      counterbalance: {
        intervention_budget: { max_activations: 1, window: "run" },
        triggers: [{ id: "periodic_scan", kind: "cron", every_seconds: 60 }],
      },
    }),
    proposals: [call("noop.ping"), call("noop.ping")],
    transcript: [rec(1, "noop.ping", {}, { ok: 1 }), rec(2, "noop.ping", {}, { ok: 1 })],
  });

  // TTL: fresh through step updated_at_step + N (spec-v0.3 §8.4). N = 1 keeps the story: evidence
  // from step 0 is usable in step 1 and stale at the start of step 2.
  await fixture("cb-memory-provenance-status", {
    agent: agent("ttl-provenance-status", {
      spec: "counterbalance-contract/v0.1",
      state: { file_observation_current: 1 },
      tools: [ping],
      limits: { max_steps: 8, max_tool_calls: 8 },
      permissions: { tools: ["noop.ping"] },
      counterbalance: {
        invalidate_after: [{ memory_keys: ["file_observation_current"], ttl_steps: 1 }],
        memory_provenance: { file_observation_current: { source: "world", status: "current", updated_at_step: 0 } },
      },
    }),
    proposals: [call("noop.ping"), call("noop.ping")],
    transcript: [rec(1, "noop.ping", {}, { ok: 1 }), rec(2, "noop.ping", {}, { ok: 1 })],
  });
  await fixture("cb-stale-after-ttl", {
    agent: agent("ttl-stale-evidence", {
      spec: "counterbalance-contract/v0.1",
      state: { open_todos: 0, test_evidence_current: 1 },
      tools: [ping, taskComplete],
      limits: { max_steps: 10, max_tool_calls: 10 },
      permissions: { tools: ["noop.ping", "task.complete"] },
      counterbalance: {
        completion: { tool: "task.complete", require: { path: "state.test_evidence_current", eq: 1 } },
        invalidate_after: [{ memory_keys: ["test_evidence_current"], ttl_steps: 1 }],
        memory_provenance: { test_evidence_current: { source: "world", status: "current", updated_at_step: 0 } },
      },
    }),
    proposals: [call("noop.ping"), call("task.complete")],
    transcript: [rec(1, "noop.ping", {}, { ok: 1 })],
  });

  // Host world obligations (spec-v0.3 §4.3): protected paths and secrets, reported by the
  // reference world, turned into verdicts by absence verifies.
  const protectedTools = [writeTool({ protected_modified: INT }, [{ path: "result.protected_modified", eq: 0 }]), taskComplete];
  const protectedPerms = {
    tools: ["fs.write_scoped", "task.complete"],
    filesystem: { read_scopes: ["src/"], write_scopes: ["src/"] },
    protected_paths: ["src/app.js"],
  };
  await fixture("cb-protected-write-denied", {
    agent: guardedCoding("cb-protected-write-denied", protectedPerms, protectedTools),
    proposals: [
      call("fs.write_scoped", { path: "src/app.js", content: 'export function greet(){ return "pwned"; }\n' }),
      { type: "stop", message: "done" },
    ],
  });
  await fixture("cb-protected-write-other-ok", {
    agent: guardedCoding("cb-protected-write-other-ok", protectedPerms, protectedTools),
    proposals: [call("fs.write_scoped", { path: "src/note.txt", content: "ok" }), call("task.complete")],
  });
  const secretTools = [fsRead, writeTool({ secret_leak: INT }, [{ path: "result.secret_leak", eq: 0 }]), taskComplete];
  const secretPerms = {
    tools: ["fs.read", "fs.write_scoped", "task.complete"],
    filesystem: { read_scopes: ["src/"], write_scopes: ["src/"] },
    secrets: { deny_write_contains: true, paths: ["src/planted.key"], values: ["sk-fixture-secret-0001"] },
  };
  await fixture("cb-secret-write-denied", {
    agent: guardedCoding("cb-secret-write-denied", secretPerms, secretTools),
    proposals: [
      call("fs.write_scoped", { path: "src/debug.log", content: "leak sk-fixture-secret-0001 here" }),
      { type: "stop", message: "done" },
    ],
  });
  await fixture("cb-secret-write-benign-ok", {
    agent: guardedCoding("cb-secret-write-benign-ok", secretPerms, secretTools),
    proposals: [call("fs.write_scoped", { path: "src/note.txt", content: "harmless note" }), call("task.complete")],
  });
}

// ---------------------------------------------------------------- v0.3 coverage

const fsWriteSimple: ToolDef = {
  id: "fs.write_scoped",
  input: OBJ({ path: STR, content: STR }, ["path"]),
  output: OBJ({ ok: INT, out_of_scope: INT, path: STR }, ["ok", "out_of_scope", "path"]),
  verify: [{ kind: "absence", require: { path: "result.out_of_scope", eq: 0 }, otherwise: "safe_state" }],
};
const spawnTool: ToolDef = {
  id: "agent.spawn",
  input: OBJ({ tools: { type: "array", items: STR } }, ["tools"], true),
  output: OBJ({ spawned: INT, tools: { type: "array", items: STR } }, ["spawned", "tools"]),
};
const userAsk: ToolDef = {
  id: "user.ask",
  channel: "user",
  input: OBJ({ question: STR }, ["question"]),
  output: OBJ({ answer: STR }, ["answer"]),
  effects: [{ when: { path: "result.answer", neq: "" }, set: { clarified: 1 } }],
};
const userApprove: ToolDef = {
  id: "user.approve",
  channel: "user",
  input: OBJ({ plan: STR }, [], true),
  output: OBJ({ approved: INT }, ["approved"]),
  effects: [{ when: { path: "result.approved", eq: 1 }, set: { approved: 1 } }],
};

async function coverage(): Promise<void> {
  // D8 / CORE-1: a call whose verify fails is not a success and commits nothing.
  const tested = agent("v03-verify-fail-not-success", {
    state: { evidence: 0, last_exit: 0 },
    tools: [
      {
        id: "shell.test",
        input: OBJ({ cmd: STR }, ["cmd"]),
        output: OBJ({ exit_code: INT }, ["exit_code"]),
        verify: [{ kind: "evidence", require: { path: "result.exit_code", eq: 0 }, otherwise: "deny" }],
        effects: [{ when: { path: "result.exit_code", eq: 0 }, set: { evidence: 1 } }],
      },
      { id: "task.done", input: OBJ(), output: OBJ({ ok: INT }, ["ok"]) },
    ],
    limits: { continue_after_deny: true },
    counterbalance: {
      sequences: [{ id: "test-before-done", action: "task.done", require_prior_tools: ["shell.test"] }],
      completion: { tool: "task.done", require: { path: "state.evidence", eq: 1 } },
    },
  });
  await fixture("v03-verify-fail-not-success", {
    agent: tested,
    proposals: [call("shell.test", { cmd: "test" }), call("task.done")],
    transcript: [
      rec(1, "shell.test", { cmd: "test" }, { output: { exit_code: 1 }, state_transition: { set: { last_exit: 1 } } }),
    ],
  });

  // D6: spawn is denied unless spawn.allow === true; agent.spawn obeys permissions; children
  // are charged to the parent.
  const spawner = (name: string, over: Partial<AgentIR> = {}) =>
    agent(name, {
      state: {},
      tools: [spawnTool, fsRead],
      permissions: { tools: ["agent.spawn", "fs.read"], filesystem: { write_scopes: ["src/"], read_scopes: ["src/"] } },
      limits: { continue_after_deny: true },
      ...over,
    });
  await fixture("v03-spawn-deny-when-unset", {
    agent: spawner("v03-spawn-deny-when-unset"),
    proposals: [call("agent.spawn", { tools: ["fs.read"] })],
  });
  await fixture("v03-spawn-not-permitted", {
    agent: spawner("v03-spawn-not-permitted", {
      spawn: { allow: true },
      permissions: { tools: ["fs.read"], filesystem: { read_scopes: ["src/"] } },
    }),
    proposals: [call("agent.spawn", { tools: ["fs.read"] })],
  });
  await fixture("v03-spawn-budget-charged", {
    agent: spawner("v03-spawn-budget-charged", { spawn: { allow: true }, limits: { max_tool_calls: 3 } }),
    proposals: [
      call("agent.spawn", {
        tools: ["fs.read"],
        proposals: [call("fs.read", { path: "src/app.ts" }), call("fs.read", { path: "src/app.js" })],
      }),
      call("fs.read", { path: "src/app.ts" }),
    ],
  });
  await fixture("v03-spawn-deny-scope-escape", {
    agent: spawner("v03-spawn-deny-scope-escape", { spawn: { allow: true } }),
    proposals: [call("agent.spawn", { tools: ["fs.read"], filesystem: { write_scopes: ["src/../../etc"] } })],
  });
  await fixture("v03-spawn-deny-scope-sibling", {
    agent: spawner("v03-spawn-deny-scope-sibling", { spawn: { allow: true } }),
    proposals: [call("agent.spawn", { tools: ["fs.read"], filesystem: { write_scopes: ["srcx/"] } })],
  });

  // D9 / CORE-6 / D14: transitions are checked before commit.
  const probe: ToolDef = { id: "world.probe", input: OBJ(), output: OBJ({ ok: INT }, ["ok"]) };
  const authority = (name: string) =>
    agent(name, {
      state: { approved: 0, seen: 0 },
      tools: [probe, userApprove],
      limits: { continue_after_deny: true },
      counterbalance: { checkpoints: [{ tool: "user.approve", allow_set_keys: ["approved"] }] },
    });
  await fixture("v03-state-write-undeclared-denied", {
    agent: authority("v03-state-write-undeclared-denied"),
    proposals: [call("world.probe")],
    transcript: [rec(1, "world.probe", {}, { output: { ok: 1 }, state_transition: { set: { invented: 1 } } })],
  });
  await fixture("v03-checkpoint-key-world-write-denied", {
    agent: authority("v03-checkpoint-key-world-write-denied"),
    proposals: [call("world.probe")],
    transcript: [rec(1, "world.probe", {}, { output: { ok: 1 }, state_transition: { set: { approved: 1 } } })],
  });

  // D10 / CORE-5: recovery runs the normal path; a gate blocks it ⇒ terminal_failure.
  const sensor: ToolDef = {
    id: "sensor.fan.read_percent",
    read_only: true,
    input: OBJ(),
    output: OBJ({ percent: INT }, ["percent"]),
  };
  await fixture("v03-recovery-gated-terminal-failure", {
    agent: agent("v03-recovery-gated-terminal-failure", {
      state: { fan_percent: 0, stop_allowed: 0 },
      tools: [
        {
          id: "actuator.fan.set",
          input: OBJ({ percent: INT }, ["percent"]),
          output: OBJ({ ok: INT, percent: INT }, ["ok", "percent"]),
          verify: [
            {
              kind: "effect",
              observe: "sensor.fan.read_percent",
              require: { path: "observation.percent", eq_path: "action.args.percent" },
            },
          ],
        },
        { id: "actuator.fan.stop", input: OBJ(), output: OBJ({ ok: INT }, ["ok"]) },
        sensor,
      ],
      gates: [{ id: "stop-needs-permit", when: { path: "action.name", eq: "actuator.fan.stop" }, require: { path: "state.stop_allowed", eq: 1 } }],
      fallback_state: { fan_percent: 0 },
      recovery: {
        on: "verify_effect_failed",
        execute: { tool: "actuator.fan.stop" },
        verify: { kind: "effect", observe: "sensor.fan.read_percent", require: { path: "observation.percent", eq: 0 } },
      },
    }),
    proposals: [call("actuator.fan.set", { percent: 40 })],
    transcript: [
      rec(1, "actuator.fan.set", { percent: 40 }, { output: { ok: 1, percent: 40 } }),
      rec(2, "sensor.fan.read_percent", {}, { output: { percent: 0 } }),
    ],
  });

  // D14: the user channel.
  const asker = (name: string) =>
    agent(name, {
      state: { clarified: 0 },
      tools: [userAsk],
      limits: { continue_after_deny: true },
      counterbalance: { checkpoints: [{ tool: "user.ask", allow_set_keys: ["clarified"] }] },
    });
  await fixture("v03-user-channel-unbound-denied", {
    agent: asker("v03-user-channel-unbound-denied"),
    proposals: [call("user.ask", { question: "refund or replacement?" })],
  });
  await fixture("v03-user-channel-recorded-answer", {
    agent: asker("v03-user-channel-recorded-answer"),
    proposals: [call("user.ask", { question: "refund or replacement?" })],
    user: [{ tool: "user.ask", call_seq: 1, result: { output: { answer: "a replacement, please" } } }],
  });
  await fixture("v03-user-answer-missing-infra", {
    agent: asker("v03-user-answer-missing-infra"),
    proposals: [call("user.ask", { question: "first?" }), call("user.ask", { question: "second?" })],
    user: [{ tool: "user.ask", call_seq: 1, result: { output: { answer: "yes" } } }],
  });

  // Integrator wiring: an unbound world tool is denied before execution.
  await fixture("v03-world-unbound-denied", {
    agent: agent("v03-world-unbound-denied", { tools: [ping] }),
    proposals: [call("noop.ping")],
  });

  // CORE-9: TTL without declared provenance is reported once per staleness transition.
  await fixture("v03-ttl-stale-once", {
    agent: agent("v03-ttl-stale-once", {
      state: { ev: 1 },
      tools: [ping],
      counterbalance: { invalidate_after: [{ ttl_steps: 1, memory_keys: ["ev"] }], orientation: { emit_each_step: true } },
    }),
    proposals: [call("noop.ping"), call("noop.ping"), call("noop.ping"), call("noop.ping")],
    transcript: [1, 2, 3, 4].map((i) => rec(i, "noop.ping", {}, { ok: 1 })),
  });

  // D3: non-canonical values are rejected where they enter.
  const scored: ToolDef = { id: "score.read", input: OBJ({ x: { type: "number" } }, [], true), output: OBJ({ score: { type: "number" } }, ["score"]) };
  await fixture("v03-non-canonical-args-denied", {
    agent: agent("v03-non-canonical-args-denied", { tools: [scored], limits: { continue_after_deny: true } }),
    proposals: [call("score.read", { x: 0.5 }), call("score.read", { x: 1.0 })],
    transcript: [rec(1, "score.read", { x: 1 }, { score: 2 })],
    lineStyle: "json",
  });
  await fixture("v03-non-canonical-output-denied", {
    agent: agent("v03-non-canonical-output-denied", { tools: [scored] }),
    proposals: [call("score.read")],
    transcript: [rec(1, "score.read", {}, { score: 0.8 })],
    lineStyle: "json",
  });

  // SPEC-10: output_schema_invalid, transcript mismatch, invalid/empty proposals.
  await fixture("v03-output-schema-invalid", {
    agent: agent("v03-output-schema-invalid", { tools: [ping] }),
    proposals: [call("noop.ping")],
    transcript: [rec(1, "noop.ping", {}, { ok: "yes" })],
  });
  await fixture("v03-transcript-mismatch", {
    agent: agent("v03-transcript-mismatch", { tools: [scored] }),
    proposals: [call("score.read", { x: 2 })],
    transcript: [rec(1, "score.read", { x: 3 }, { score: 1 })],
  });
  await fixture("v03-invalid-proposal-cap", {
    agent: agent("v03-invalid-proposal-cap", { tools: [ping], limits: { continue_after_deny: true } }),
    proposals: [
      { type: "invalid", reason: "invalid_tool_arguments_json", message: '{"path": ' },
      { type: "invalid", reason: "empty_proposal", message: "I would read the file first." },
      call("noop.ping"),
    ],
  });

  // SPEC-10: agent-level output verifies on stop messages.
  const chatty = (name: string) =>
    agent(name, {
      state: { session_open: 1 },
      tools: [ping],
      counterbalance: {
        output_verifies: [{ kind: "output", require: { path: "message.contains_code_fence", eq: 0 }, otherwise: "deny" }],
      },
    });
  await fixture("v03-output-verify-stop-denied", {
    agent: chatty("v03-output-verify-stop-denied"),
    proposals: [{ type: "stop", message: "Here is the solution:\n```py\nprint(42)\n```" }],
  });
  await fixture("v03-output-verify-stop-ok", {
    agent: chatty("v03-output-verify-stop-ok"),
    proposals: [{ type: "stop", message: "What do you expect the loop to print first?" }],
  });

  // SPEC-10: sequence require_state with a checkpoint unblock.
  await fixture("v03-sequence-require-state-denied", {
    agent: agent("v03-sequence-require-state-denied", {
      state: { approved: 0 },
      tools: [{ id: "release.ship", input: OBJ(), output: OBJ({ ok: INT }, ["ok"]) }, userApprove],
      counterbalance: {
        sequences: [{ id: "approved-before-ship", action: "release.ship", require_state: { path: "state.approved", eq: 1 } }],
        checkpoints: [{ tool: "user.approve", allow_set_keys: ["approved"] }],
      },
    }),
    proposals: [call("release.ship")],
    transcript: [], // recorded run (the tool is bound); refused at authorize, nothing executes
  });

  // SPEC-10: predicate operators incl. MISSING under not; D16 own members only.
  const level: ToolDef = {
    id: "dial.set",
    input: OBJ({ level: INT, mode: STR, override: INT, confirm: INT }, ["level"]),
    output: OBJ({ ok: INT }, ["ok"]),
  };
  const isDial = { path: "action.name", eq: "dial.set" };
  await fixture("v03-predicate-operators", {
    agent: agent("v03-predicate-operators", {
      tools: [level],
      limits: { continue_after_deny: true },
      gates: [
        { id: "range", when: isDial, require: { all: [{ path: "action.args.level", gte: 0 }, { path: "action.args.level", lt: 100 }] } },
        { id: "safe-or-low", when: isDial, require: { any: [{ path: "action.args.mode", eq: "safe" }, { path: "action.args.level", lte: 10 }] } },
        { id: "no-override", when: isDial, require: { not: { path: "action.args.override", eq: 1 } } },
        { id: "not-13", when: isDial, require: { path: "action.args.level", neq: 13 } },
        { id: "confirm-high", when: { path: "action.args.level", gt: 50 }, require: { path: "action.args.confirm", eq_path: "action.args.level" } },
      ],
    }),
    proposals: [
      call("dial.set", { level: 5 }),
      call("dial.set", { level: 13 }),
      call("dial.set", { level: 13, mode: "safe" }),
      call("dial.set", { level: 7, override: 1 }),
      call("dial.set", { level: 120, mode: "safe" }),
      call("dial.set", { level: 60, mode: "safe", confirm: 60 }),
      call("dial.set", { level: 60, mode: "safe" }),
    ],
    transcript: [
      rec(1, "dial.set", { level: 5 }, { ok: 1 }),
      rec(2, "dial.set", { level: 60, mode: "safe", confirm: 60 }, { ok: 1 }),
    ],
  });
  await fixture("v03-predicate-own-members", {
    agent: agent("v03-predicate-own-members", {
      state: { tags: ["a", "b"], note: "x" },
      tools: [ping],
      limits: { continue_after_deny: true },
      gates: [
        // Inherited members never resolve: MISSING, so `neq` is false ⇒ deny (was true before D16).
        { id: "proto", require: { path: "state.constructor", neq: 1 } },
      ],
    }),
    proposals: [call("noop.ping")],
    transcript: [], // recorded run; denied at authorize
  });
  await fixture("v03-predicate-no-array-length", {
    agent: agent("v03-predicate-no-array-length", {
      state: { tags: ["a", "b"] },
      tools: [ping],
      gates: [{ id: "len", require: { not: { path: "state.tags.length", gte: 1 } } }],
    }),
    proposals: [call("noop.ping")],
    transcript: [rec(1, "noop.ping", {}, { ok: 1 })],
  });

  // SPEC-10: window host_day is host-persisted (no engine event).
  await fixture("v03-budget-host-day", {
    agent: agent("v03-budget-host-day", {
      tools: [ping],
      counterbalance: { intervention_budget: { max_activations: 1, window: "host_day" } },
    }),
    proposals: [call("noop.ping"), call("noop.ping")],
    transcript: [rec(1, "noop.ping", {}, { ok: 1 }), rec(2, "noop.ping", {}, { ok: 1 })],
  });

  // SPEC-10: instinct_text as a mutable cell (harness hash over the declared IR).
  const reflect: ToolDef = {
    id: "harness.reflect_skills",
    input: OBJ({ disposition: STR, reason: STR, note: STR, ops: { type: "array", items: { type: "object" } } }, ["disposition"]),
    output: OBJ({ ok: INT, disposition: STR, proposed: INT, declined: INT }, ["ok", "disposition"]),
  };
  const instinctOps = [{ op: "set_instinct_text", text: "Ask before acting when the request is ambiguous." }];
  await fixture("v03-harness-patch-instinct-ok", {
    agent: agent("v03-harness-patch-instinct-ok", {
      state: { seen: 0 },
      tools: [reflect],
      mutable: ["instincts"],
      instinct_text: "Act decisively.",
    }),
    proposals: [call("harness.reflect_skills", { disposition: "propose", ops: instinctOps })],
    transcript: [
      rec(1, "harness.reflect_skills", { disposition: "propose", ops: instinctOps }, { ok: 1, disposition: "propose", proposed: 1 }),
    ],
  });

  // SPEC-10: overlays in the IR are resolved by hosts, ignored by the engine at run time.
  const pong: ToolDef = { id: "noop.pong", input: OBJ(), output: OBJ({ ok: INT }, ["ok"]) };
  await fixture("v03-overlays-in-ir-ignored", {
    agent: agent("v03-overlays-in-ir-ignored", {
      tools: [ping, pong],
      permissions: { tools: ["noop.ping", "noop.pong"] },
      overlays: [{ when_model: "kit.glm-5.3-flash", tools: ["noop.ping"], limits: { max_steps: 2 } }],
    }),
    proposals: [call("noop.pong")],
    transcript: [rec(1, "noop.pong", {}, { ok: 1 })],
  });

  // SPEC-12: orientation advertises exactly the permitted set.
  await fixture("v03-orientation-permitted-only", {
    agent: agent("v03-orientation-permitted-only", {
      state: { kb_cited: 0 },
      tools: [
        { id: "kb.lookup", read_only: true, input: OBJ({ query: STR }, ["query"]), output: OBJ({ ok: INT }, ["ok"]) },
        { id: "refund.request", input: OBJ(), output: OBJ({ ok: INT }, ["ok"]) },
      ],
      permissions: { tools: ["kb.lookup"] },
      counterbalance: { orientation: { emit_each_step: true } },
    }),
    proposals: [call("refund.request")],
  });
}

async function main(): Promise<void> {
  await formerlyHandWritten();
  await coverage();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
