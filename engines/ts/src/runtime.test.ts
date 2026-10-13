/**
 * Engine regression tests (docs/spec-v0.3.md). Each block names the audit finding / decision.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FaustRuntime, eventsToJsonl, type JudgeFn, type ToolHandler } from "./runtime.js";
import { stateHash } from "./canonical.js";
import { harnessIrHash } from "./harness-patch.js";
import { buildReplayWorld } from "./replay.js";
import { AdapterError } from "./adapters/error.js";
import type { AgentIR, Event, ModelProposal, RecordedToolCall, ToolDef } from "./types.js";

const OPEN = { type: "object", additionalProperties: true } as const;

function tool(id: string, extra: Partial<ToolDef> = {}): ToolDef {
  return { id, input: OPEN, output: OPEN, ...extra };
}

function agent(over: Partial<AgentIR>): AgentIR {
  return { spec: "counterbalance-contract/v0.3", name: "t", state: {}, tools: [], ...over };
}

async function run(
  a: AgentIR,
  proposals: ModelProposal[],
  tools: Record<string, ToolHandler> = {},
  extra: { recorded?: RecordedToolCall[]; judge?: JudgeFn; iterations?: number } = {},
): Promise<{ rt: FaustRuntime; events: Event[] }> {
  const queue = [...proposals];
  const rt = new FaustRuntime({
    agent: a,
    propose: async () => queue.shift() ?? { type: "stop" },
    tools,
    ...(extra.recorded ? { recordedToolResults: extra.recorded } : {}),
    ...(extra.judge ? { judge: extra.judge, allowJudge: true } : {}),
  });
  await rt.runLoop(extra.iterations ?? 32);
  return { rt, events: rt.events };
}

const call = (name: string, args: Record<string, unknown> = {}): ModelProposal => ({ type: "tool", name, args });
const find = (events: Event[], p: Partial<Event>) =>
  events.find((e) => Object.entries(p).every(([k, v]) => (e as Record<string, unknown>)[k] === v));

describe("D8 / CORE-1: success = executed AND verified", () => {
  const a = () =>
    agent({
      state: { evidence: 0 },
      tools: [
        tool("test", { verify: [{ kind: "evidence", require: { path: "result.exit_code", eq: 0 }, otherwise: "deny" }] }),
        tool("done"),
      ],
      limits: { continue_after_deny: true },
      counterbalance: {
        sequences: [{ action: "done", require_prior_tools: ["test"] }],
        completion: { tool: "done" },
      },
    });

  it("a failing test does not unlock require_prior_tools", async () => {
    const { events } = await run(a(), [call("test"), call("done")], {
      test: () => ({ output: { exit_code: 1 } }),
      done: () => ({ ok: 1 }),
    });
    const deny = find(events, { stage: "authorize", tool: "done", reason: "sequence_requirement_failed" });
    assert.ok(deny, "done must be denied");
    assert.deepEqual(deny!.failure, { kind: "missing_prior_tools", missing_prior_tools: ["test"] });
    assert.equal(find(events, { reason: "run_complete" }), undefined);
  });

  it("the verify-failed call's state transition is not committed, and the event shows it", async () => {
    const before = stateHash({ evidence: 0 });
    const after = stateHash({ evidence: 1 });
    const { rt, events } = await run(a(), [call("test")], {
      test: () => ({ output: { exit_code: 1 }, state_transition: { set: { evidence: 1 } } }),
    });
    assert.equal(find(events, { stage: "execute", tool: "test" })!.state_hash, after, "provisional");
    const fail = find(events, { stage: "verify", reason: "verify_evidence_failed" })!;
    assert.equal(fail.state_hash, before, "discarded before the failure event");
    assert.deepEqual(rt.agent.state, { evidence: 0 });
    assert.deepEqual(rt.successfulTools(), []);
  });

  it("a passing test commits and counts", async () => {
    const { rt, events } = await run(a(), [call("test"), call("done")], {
      test: () => ({ output: { exit_code: 0 }, state_transition: { set: { evidence: 1 } } }),
      done: () => ({ ok: 1 }),
    });
    assert.deepEqual(rt.agent.state, { evidence: 1 });
    assert.ok(find(events, { stage: "record", reason: "run_complete", tool: "done" }));
  });

  it("a verify-failed reflection does not count as the phase's reflection (reflectionAlreadyDone)", async () => {
    const b = agent({
      state: {},
      mutable: ["skills"],
      tools: [
        tool("harness.propose_skills_patch", {
          verify: [{ kind: "evidence", require: { path: "result.ok", eq: 2 }, otherwise: "deny" }],
        }),
        tool("harness.decline_skills_patch"),
      ],
      limits: { continue_after_deny: true },
    });
    const { events } = await run(
      b,
      [
        call("harness.propose_skills_patch", { ops: [{ op: "set_tool_description", tool_id: "harness.decline_skills_patch", description: "x" }] }),
        call("harness.decline_skills_patch", { reason: "no_new_heuristic" }),
      ],
      { "harness.propose_skills_patch": () => ({ ok: 1 }), "harness.decline_skills_patch": () => ({ ok: 1 }) },
    );
    assert.equal(find(events, { stage: "rebalance" }), undefined, "patch not applied");
    assert.ok(find(events, { stage: "record", reason: "harness_patch_declined" }), "decline still allowed");
  });

  it("safe_state ends the run even with continue_after_deny", async () => {
    const c = agent({
      state: {},
      tools: [tool("w", { verify: [{ kind: "absence", require: { path: "result.bad", eq: 0 } }] }), tool("x")],
      limits: { continue_after_deny: true },
    });
    const { events } = await run(c, [call("w"), call("x")], { w: () => ({ bad: 1 }), x: () => ({}) });
    assert.equal(events.at(-1)!.reason, "safe_state_entered");
    assert.equal(find(events, { stage: "propose", tool: "x" }), undefined);
  });
});

describe("D6 / CORE-2 / CORE-14 / SPEC-11: spawn", () => {
  const spawnTool = tool("agent.spawn");
  const base = (over: Partial<AgentIR> = {}) =>
    agent({
      state: {},
      tools: [spawnTool, tool("read", { read_only: true })],
      permissions: { tools: ["agent.spawn", "read"], filesystem: { write_scopes: ["src"], read_scopes: ["src"] } },
      limits: { max_tool_calls: 5, continue_after_deny: true },
      ...over,
    });
  const handlers: Record<string, ToolHandler> = {
    "agent.spawn": (args) => ({ spawned: 1, tools: args.tools as unknown[] }),
    read: () => ({ ok: 1 }),
  };

  it("is denied when the spawn block is missing or {}", async () => {
    for (const spawn of [undefined, {}]) {
      const { events } = await run(base(spawn ? { spawn } : {}), [call("agent.spawn", { tools: ["read"] })], handlers);
      const deny = find(events, { stage: "authorize", reason: "gate_denied" })!;
      assert.deepEqual(deny.failure, { kind: "spawn", code: "not_allowed" });
    }
  });

  it("is subject to permissions.tools like any tool", async () => {
    const a = base({ spawn: { allow: true }, permissions: { tools: ["read"] } });
    const { events } = await run(a, [call("agent.spawn", { tools: ["read"] })], handlers);
    assert.ok(find(events, { stage: "validate", tool: "agent.spawn", reason: "capability_missing" }));
  });

  it("charges child steps and tool calls to the parent", async () => {
    const a = base({ spawn: { allow: true } });
    const { rt, events } = await run(
      a,
      [
        call("agent.spawn", {
          tools: ["read"],
          proposals: [
            { type: "tool", name: "read", args: {} },
            { type: "tool", name: "read", args: {} },
          ],
        }),
        call("read"),
        call("read"),
      ],
      handlers,
    );
    const ret = find(events, { stage: "record", reason: "spawn_returned" })!;
    assert.deepEqual(ret.result, { events: ret.result!.events, steps: 3, tool_calls: 2 });
    // 1 spawn + 2 child calls + 1 parent read = 4 < 5, the next read hits the limit
    const usage = rt.usage();
    assert.equal(usage.tool_calls, 5);
    assert.ok(events.some((e) => e.reason === "limit_exceeded" && e.depth === undefined));
  });

  it("a child cannot be given more calls than the parent has left after the spawn itself", async () => {
    const a = base({ spawn: { allow: true } });
    const { events } = await run(a, [call("agent.spawn", { tools: ["read"], limits: { max_tool_calls: 5 } })], handlers);
    const deny = find(events, { stage: "authorize", reason: "gate_denied" })!;
    assert.deepEqual(deny.failure, { kind: "spawn", code: "escalation", dimension: "max_tool_calls" });
  });

  it("D7 / CORE-3: scopes are normalized and contained segment-wise", async () => {
    const a = base({ spawn: { allow: true } });
    const cases: [string[], unknown][] = [
      [["src/../../etc"], { kind: "spawn", code: "malformed" }],
      [["/etc"], { kind: "spawn", code: "malformed" }],
      [["srcx"], { kind: "spawn", code: "escalation", dimension: "write_scopes" }],
      [["."], { kind: "spawn", code: "escalation", dimension: "write_scopes" }],
    ];
    for (const [scopes, failure] of cases) {
      const { events } = await run(a, [call("agent.spawn", { tools: ["read"], filesystem: { write_scopes: scopes } })], handlers);
      const deny = events.find((e) => e.stage === "authorize" && e.verdict === "deny")!;
      assert.deepEqual(deny.failure, failure, JSON.stringify(scopes));
    }
    const ok = await run(a, [call("agent.spawn", { tools: ["read"], filesystem: { write_scopes: ["./src/lib/"] } })], handlers);
    assert.ok(find(ok.events, { stage: "execute", tool: "agent.spawn", verdict: "allow" }));
    const root = await run(
      base({ spawn: { allow: true }, permissions: { tools: ["agent.spawn", "read"], filesystem: { write_scopes: ["."] } } }),
      [call("agent.spawn", { tools: ["read"], filesystem: { write_scopes: ["anything/deep"] } })],
      handlers,
    );
    assert.ok(find(root.events, { stage: "execute", tool: "agent.spawn", verdict: "allow" }));
  });

  it("children inherit secrets and protected paths (never widened)", async () => {
    const a = base({
      spawn: { allow: true },
      permissions: {
        tools: ["agent.spawn", "read"],
        secrets: { values: ["s3cr3t-value"] },
        protected_paths: ["src/app.js"],
      },
    });
    const seen: Record<string, unknown>[] = [];
    const { events } = await run(
      a,
      [call("agent.spawn", { tools: ["read"], proposals: [{ type: "tool", name: "read", args: {} }] })],
      { ...handlers, read: () => (seen.push({}), { leaked: "x s3cr3t-value y" }) },
    );
    const childExec = events.find((e) => e.depth === 1 && e.stage === "execute")!;
    assert.deepEqual(childExec.result, { leaked: "x [redacted] y" });
  });
});

describe("D9 / CORE-6 / CORE-7: state authority", () => {
  const a = () =>
    agent({
      state: { open_todos: 1, plan_approved: 0, evidence: 0 },
      tools: [tool("user.correct", { channel: "user" }), tool("user.approve", { channel: "user" }), tool("work")],
      limits: { continue_after_deny: true },
      counterbalance: {
        checkpoints: [
          { tool: "user.correct", allow_set_keys: ["open_todos"] },
          { tool: "user.approve", allow_set_keys: ["plan_approved"] },
        ],
      },
    });

  it("checkpoint authority on the request is checked at authorize, before any side effect", async () => {
    let calls = 0;
    const { events } = await run(a(), [call("user.correct", { set: { open_todos: 0, plan_approved: 1 } })], {
      "user.correct": () => (calls++, { ok: 1 }),
    });
    const deny = find(events, { stage: "authorize", reason: "checkpoint_authority_failed" })!;
    assert.deepEqual(deny.failure, { kind: "checkpoint_key", checkpoint_key: "plan_approved" });
    assert.equal(calls, 0, "the user channel was never asked");
    assert.equal(find(events, { stage: "execute" }), undefined);
  });

  it("a world tool cannot write a user-decision key (plan_approved)", async () => {
    const { rt, events } = await run(a(), [call("work")], {
      work: () => ({ output: { ok: 1 }, state_transition: { set: { plan_approved: 1 } } }),
    });
    const deny = find(events, { stage: "execute", reason: "checkpoint_authority_failed" })!;
    assert.deepEqual(deny.failure, { kind: "checkpoint_key", checkpoint_key: "plan_approved" });
    assert.equal(rt.agent.state.plan_approved, 0);
  });

  it("undeclared state keys are not writable (spec-v0.1 §5.2 step 2)", async () => {
    const { rt, events } = await run(a(), [call("work")], {
      work: () => ({ output: { ok: 1 }, state_transition: { set: { invented_key: 1 } } }),
    });
    const deny = find(events, { stage: "execute", reason: "state_write_denied" })!;
    assert.deepEqual(deny.failure, { kind: "state_key", state_key: "invented_key" });
    assert.equal("invented_key" in rt.agent.state, false);
  });

  it("a checkpoint tool may write only its own keys", async () => {
    const { events } = await run(a(), [call("user.correct")], {
      "user.correct": () => ({ output: { ok: 1 }, state_transition: { set: { open_todos: 0, evidence: 1 } } }),
    });
    const deny = find(events, { stage: "execute", reason: "checkpoint_authority_failed" })!;
    assert.deepEqual(deny.failure, { kind: "checkpoint_key", checkpoint_key: "evidence" });
  });
});

describe("D10 / CORE-5: recovery runs the normal path", () => {
  const base = (over: Partial<AgentIR> = {}) =>
    agent({
      state: { fan: 0 },
      tools: [
        tool("set", { verify: [{ kind: "evidence", require: { path: "result.ok", eq: 1 } }] }),
        tool("off"),
      ],
      recovery: { execute: { tool: "off", args: {} }, verify: { kind: "evidence", require: { path: "result.ok", eq: 1 } } },
      fallback_state: { fan: 0 },
      ...over,
    });
  const handlers = { set: () => ({ ok: 0 }), off: () => ({ ok: 1 }) };

  it("marks the harness-originated proposal and succeeds when allowed", async () => {
    const { events } = await run(base(), [call("set")], handlers);
    const p = find(events, { stage: "propose", tool: "off" })!;
    assert.equal(p.reason, "recovery_attempt");
    assert.ok(find(events, { reason: "recovery_succeeded" }));
  });

  it("is subject to gates (no authorize:allow without checks)", async () => {
    const a = base({ gates: [{ when: { path: "action.name", eq: "off" }, require: { path: "state.fan", eq: 99 } }] });
    const { events } = await run(a, [call("set")], handlers);
    assert.ok(find(events, { stage: "authorize", tool: "off", reason: "gate_denied" }));
    assert.ok(find(events, { reason: "terminal_failure" }));
    assert.equal(find(events, { reason: "recovery_succeeded" }), undefined);
  });

  it("is subject to permissions and limits", async () => {
    const p = await run(base({ permissions: { tools: ["set"] } }), [call("set")], handlers);
    assert.ok(find(p.events, { stage: "validate", tool: "off", reason: "capability_missing" }));
    assert.ok(find(p.events, { reason: "terminal_failure" }));
    const l = await run(base({ limits: { max_tool_calls: 1 } }), [call("set")], handlers);
    assert.ok(find(l.events, { stage: "authorize", tool: "off", reason: "limit_exceeded" }));
    assert.ok(find(l.events, { reason: "terminal_failure" }));
  });
});

describe("D11 / CORE-20 / SPEC-1 / SPEC-12: no name magic, generic orientation", () => {
  it("orientation has no plan block and honors permissions; completion only when declared", async () => {
    const a = agent({
      state: { plan_approved: 1 },
      tools: [tool("user.approve", { channel: "user" }), tool("phase.yield"), tool("refund.request")],
      permissions: { tools: ["user.approve", "phase.yield"] },
      counterbalance: { orientation: { emit_each_step: true } },
    });
    const { events } = await run(a, []);
    const frame = events[0]!.observation!;
    assert.deepEqual(frame, { permitted_tools: ["phase.yield", "user.approve"], sequence_blockers: [], freshness: {} });
  });

  it("phase.yield is an ordinary tool unless declared as the completion tool", async () => {
    const tools = [tool("phase.yield"), tool("read")];
    const handlers = { "phase.yield": () => ({ ok: 1 }), read: () => ({ ok: 1 }) };
    const plain = await run(agent({ tools }), [call("phase.yield"), call("read")], handlers);
    assert.equal(find(plain.events, { reason: "run_complete" }), undefined);
    assert.ok(find(plain.events, { stage: "execute", tool: "read" }), "run continued");
    const declared = await run(
      agent({ tools, counterbalance: { completion: { tool: "phase.yield" } } }),
      [call("phase.yield"), call("read")],
      handlers,
    );
    assert.ok(find(declared.events, { stage: "record", reason: "run_complete", tool: "phase.yield" }));
    assert.equal(find(declared.events, { stage: "execute", tool: "read" }), undefined);
  });

  it("task.complete is not a default terminal tool", async () => {
    const { events } = await run(agent({ tools: [tool("task.complete")] }), [call("task.complete")], {
      "task.complete": () => ({ ok: 1 }),
    });
    assert.equal(find(events, { reason: "run_complete" }), undefined);
  });
});

describe("D13 / CORE-8: structured, bounded, redacted world feedback", () => {
  const a = agent({
    state: {},
    tools: [tool("shell.run_allowlisted", { verify: [{ kind: "evidence", require: { path: "result.exit_code", eq: 0 }, otherwise: "deny" }] })],
    permissions: { secrets: { values: ["sk-live-123"] } },
    limits: { max_observation_chars: 10 },
  });

  it("no engine prose and no tool-name special cases on verify failure", async () => {
    const { events } = await run(a, [call("shell.run_allowlisted", { cmd: "test" })], {
      "shell.run_allowlisted": () => ({ exit_code: 1, stdout: "0123456789abcdef", stderr: "key=sk-live-123" }),
    });
    const fail = find(events, { stage: "verify", reason: "verify_evidence_failed" })!;
    assert.equal(fail.observation, undefined, "no duplicated stdout/hint observation");
    assert.deepEqual(fail.result, { exit_code: 1, stdout: "0123456789…[truncated]", stderr: "key=[redac…[truncated]" });
    assert.ok(!JSON.stringify(events).includes("sk-live-123"));
    assert.ok(!JSON.stringify(events).includes("hint"));
  });

  it("host error messages are redacted world feedback", async () => {
    const { events } = await run(a, [call("shell.run_allowlisted", { cmd: "x" })], {
      "shell.run_allowlisted": () => {
        throw new Error("boom sk-live-123");
      },
    });
    const fail = find(events, { stage: "execute", reason: "tool_execution_failed" })!;
    assert.deepEqual(fail.failure, { kind: "host_error" });
    assert.equal(fail.error, "boom [reda…[truncated]");
  });
});

describe("D14: the user channel", () => {
  const a = agent({
    state: { clarified: 0 },
    tools: [tool("user.ask", { channel: "user" })],
    counterbalance: { checkpoints: [{ tool: "user.ask", allow_set_keys: ["clarified"] }] },
  });

  it("an unbound user channel denies with capability_missing (never synthesized)", async () => {
    const { events } = await run(a, [call("user.ask", { question: "refund or replace?" })]);
    const deny = find(events, { stage: "validate", reason: "capability_missing" })!;
    assert.deepEqual(deny.failure, { kind: "channel_unbound", channel: "user" });
  });

  it("recorded answers come from the transcript, not from the question", async () => {
    const { events, rt } = await run(a, [call("user.ask", { question: "refund or replace?" })], {}, {
      recorded: [
        {
          call_seq: 1,
          tool: "user.ask",
          args: { question: "refund or replace?" },
          result: { output: { answer: "replace" }, state_transition: { set: { clarified: 1 } } },
        },
      ],
    });
    assert.deepEqual(find(events, { stage: "execute", tool: "user.ask" })!.result, { answer: "replace" });
    assert.equal(rt.agent.state.clarified, 1);
  });

  it("the Track A replay world never answers for a user-channel tool", () => {
    const world = buildReplayWorld({ ...a, tools: [...a.tools, tool("fs.read")] });
    assert.equal(world["user.ask"], undefined);
    assert.equal(typeof world["fs.read"], "function");
  });
});

describe("integrator wiring: unbound handlers and host infrastructure", () => {
  it("a world tool without a host handler is denied before execution (capability_missing)", async () => {
    const { rt, events } = await run(agent({ tools: [tool("t")] }), [call("t")], {});
    const deny = find(events, { stage: "validate", reason: "capability_missing" })!;
    assert.deepEqual(deny.failure, { kind: "channel_unbound", channel: "world" });
    assert.equal(find(events, { stage: "execute" }), undefined);
    assert.equal(rt.usage().tool_calls, 0);
  });

  it("an AdapterError is infra_failure (not tool_execution_failed) and ends the run", async () => {
    const a = agent({ state: { x: 0 }, tools: [tool("t"), tool("u")], limits: { continue_after_deny: true } });
    const { rt, events } = await run(a, [call("t"), call("u")], {
      t: () => {
        throw new AdapterError("user_channel_unavailable", "adapter failure: no recorded user answer");
      },
      u: () => ({ ok: 1 }),
    });
    const f = find(events, { stage: "execute", reason: "infra_failure" })!;
    assert.deepEqual(f.failure, { kind: "adapter", code: "user_channel_unavailable" });
    assert.equal(find(events, { reason: "tool_execution_failed" }), undefined);
    assert.equal(find(events, { stage: "propose", tool: "u" }), undefined, "run ended despite continue_after_deny");
    assert.equal(rt.infraFailed, true);
  });

  it("an AdapterError detail travels as canonical, redacted, bounded failure.detail", async () => {
    const a = agent({ tools: [tool("t")], permissions: { secrets: { values: ["sk-secret-99"] } } });
    const { events } = await run(a, [call("t")], {
      t: () => {
        throw new AdapterError("user_channel_unavailable", "adapter failure: simulator down", {
          detail: { model_error: { kind: "timeout", message: "key sk-secret-99 rejected", score: 0.5 } },
        });
      },
    });
    const f = find(events, { reason: "infra_failure" })!;
    assert.deepEqual(f.failure, { kind: "adapter", code: "user_channel_unavailable" }, "non-canonical detail is dropped");
    const ok = await run(a, [call("t")], {
      t: () => {
        throw new AdapterError("user_channel_unavailable", "adapter failure: simulator down", {
          detail: { model_error: { kind: "timeout", message: "key sk-secret-99 rejected", status: 504 } },
        });
      },
    });
    assert.deepEqual(find(ok.events, { reason: "infra_failure" })!.failure, {
      kind: "adapter",
      code: "user_channel_unavailable",
      detail: { model_error: { kind: "timeout", message: "key [redacted] rejected", status: 504 } },
    });
  });

  it("an observer infra failure ends verification without claiming a verify result", async () => {
    const a = agent({
      state: { x: 0 },
      tools: [
        tool("set", { verify: [{ kind: "effect", observe: "read", require: { path: "observation.ok", eq: 1 } }] }),
        tool("read", { read_only: true, input: { type: "object" } }),
      ],
    });
    const { rt, events } = await run(a, [call("set")], {
      set: () => ({ output: { ok: 1 }, state_transition: { set: { x: 1 } } }),
      read: () => {
        throw new AdapterError("host_session_failed", "adapter failure: sensor offline");
      },
    });
    assert.ok(find(events, { stage: "observe", reason: "infra_failure" }));
    const v = find(events, { stage: "verify", reason: "infra_failure" })!;
    assert.deepEqual(v.failure, { kind: "adapter", code: "host_session_failed" });
    assert.equal(find(events, { reason: "safe_state_entered" }), undefined);
    assert.deepEqual(rt.agent.state, { x: 0 }, "nothing committed after infra");
  });
});

describe("D11: declared state effects replace adapter/engine state-key magic", () => {
  const a = () =>
    agent({
      state: { evidence: 0, approved: 0, yielded: 0 },
      tools: [
        tool("test", {
          effects: [{ when: { path: "result.exit_code", eq: 0 }, set: { evidence: 1 } }],
        }),
        tool("approve", { channel: "user", effects: [{ when: { path: "result.ok", eq: 1 }, set: { approved: 1 } }] }),
        tool("yield", { effects: [{ set: { yielded: 1 } }] }),
      ],
      limits: { continue_after_deny: true },
      counterbalance: { checkpoints: [{ tool: "approve", allow_set_keys: ["approved"] }] },
    });

  it("an effect applies only when its condition holds on the result", async () => {
    const fail = await run(a(), [call("test")], { test: () => ({ exit_code: 1 }) });
    assert.equal(fail.rt.agent.state.evidence, 0);
    const pass = await run(a(), [call("test")], { test: () => ({ exit_code: 0 }) });
    assert.equal(pass.rt.agent.state.evidence, 1);
  });

  it("the user's answer is mapped to the decision key by the harness, not by the host", async () => {
    const { rt } = await run(a(), [call("approve", { plan: "p" })], { approve: () => ({ ok: 1 }) });
    assert.equal(rt.agent.state.approved, 1);
  });

  it("declared effects override a host-returned value for the same key and obey authority", async () => {
    const { rt } = await run(a(), [call("yield")], {
      yield: () => ({ output: { ok: 1 }, state_transition: { set: { yielded: 0 } } }),
    });
    assert.equal(rt.agent.state.yielded, 1);
  });
});

describe("CORE-9 / SPEC-14: TTL", () => {
  const a = (ttl: number, provenance = false) =>
    agent({
      state: { ev: 1 },
      tools: [tool("ping")],
      counterbalance: {
        invalidate_after: [{ ttl_steps: ttl, memory_keys: ["ev"] }],
        ...(provenance ? { memory_provenance: { ev: { status: "current", updated_at_step: 0 } } } : {}),
      },
    });
  const pings = (n: number) => Array.from({ length: n }, () => call("ping"));

  it("evidence is fresh through step updated_at + N (no off-by-one)", async () => {
    const { events } = await run(a(1), pings(3), { ping: () => ({ ok: 1 }) });
    const stale = events.filter((e) => e.reason === "memory_stale");
    assert.equal(stale.length, 1);
    // step 1 fresh (age 1 = N), stale at the start of step 2
    const idx = events.indexOf(stale[0]!);
    assert.equal(events.slice(0, idx).filter((e) => e.stage === "propose" && e.tool).length, 1);
    assert.deepEqual(stale[0]!.result, { invalidated: ["ev"], ttl_steps: 1 });
  });

  it("emits once per staleness transition, also without declared provenance", async () => {
    const { events } = await run(a(1), pings(6), { ping: () => ({ ok: 1 }) });
    assert.equal(events.filter((e) => e.reason === "memory_stale").length, 1);
  });

  it("a fresh write re-arms the TTL", async () => {
    const b = a(1);
    const { events } = await run(b, pings(6), {
      ping: () => ({ output: { ok: 1 }, state_transition: { set: { ev: 1 } } }),
    });
    // written every step: never older than 1 step → never stale
    assert.equal(events.filter((e) => e.reason === "memory_stale").length, 0);
  });
});

describe("SPEC-13: intervention budget", () => {
  it("emits budget_exceeded once, at the first step beyond max_activations", async () => {
    const a = agent({ tools: [tool("ping")], counterbalance: { intervention_budget: { max_activations: 1 } } });
    const { events } = await run(a, [call("ping"), call("ping"), call("ping")], { ping: () => ({ ok: 1 }) });
    const b = events.filter((e) => e.reason === "budget_exceeded");
    assert.equal(b.length, 1);
    assert.deepEqual(b[0]!.result, { activations: 2, max_activations: 1, window: "run" });
  });

  it("window host_day is host-persisted: the engine emits nothing", async () => {
    const a = agent({
      tools: [tool("ping")],
      counterbalance: { intervention_budget: { max_activations: 1, window: "host_day" } },
    });
    const { events } = await run(a, [call("ping"), call("ping")], { ping: () => ({ ok: 1 }) });
    assert.equal(events.filter((e) => e.reason === "budget_exceeded").length, 0);
  });
});

describe("D3 / CORE-19: non-canonical values and judges never crash the run", () => {
  it("judge verify without a judge (Track A) is verify_judge_invalid, not a throw", async () => {
    const a = agent({ tools: [tool("t", { verify: [{ kind: "judge", rubric: "r", require: { path: "judgment.score", eq: 1 } }] })] });
    const { events } = await run(a, [call("t")], { t: () => ({ ok: 1 }) });
    const f = find(events, { reason: "verify_judge_invalid" })!;
    assert.deepEqual(f.failure, { kind: "judge", code: "unavailable" });
    assert.doesNotThrow(() => eventsToJsonl(events));
  });

  it("a float judge score is an invalid judgment", async () => {
    const a = agent({ tools: [tool("t", { verify: [{ kind: "judge", rubric: "r", require: { path: "judgment.score", gte: 1 } }] })] });
    const { events } = await run(a, [call("t")], { t: () => ({ ok: 1 }) }, { judge: async () => ({ score: 0.8, reason: "meh" }) });
    assert.deepEqual(find(events, { reason: "verify_judge_invalid" })!.failure, { kind: "judge", code: "invalid" });
    assert.doesNotThrow(() => eventsToJsonl(events));
  });

  it("a float in tool output is rejected where it enters", async () => {
    const { events } = await run(agent({ tools: [tool("t")] }), [call("t")], { t: () => ({ score: 0.5 }) });
    const f = find(events, { stage: "execute", reason: "output_schema_invalid" })!;
    assert.deepEqual(f.failure, { kind: "non_canonical", path: "$.result.score" });
    assert.doesNotThrow(() => eventsToJsonl(events));
  });

  it("a float in proposal args is rejected at propose", async () => {
    const { events } = await run(agent({ tools: [tool("t")] }), [call("t", { pct: 40.5 })], { t: () => ({ ok: 1 }) });
    const f = events[0]!;
    assert.equal(f.stage, "propose");
    assert.equal(f.reason, "input_schema_invalid");
    assert.deepEqual(f.failure, { kind: "non_canonical", path: "$.args.pct" });
    assert.doesNotThrow(() => eventsToJsonl(events));
  });

  it("a non-canonical transition value is rejected", async () => {
    const { events } = await run(agent({ state: { x: 0 }, tools: [tool("t")] }), [call("t")], {
      t: () => ({ output: { ok: 1 }, state_transition: { set: { x: 0.5 } } }),
    });
    assert.deepEqual(find(events, { stage: "execute", reason: "output_schema_invalid" })!.failure, {
      kind: "non_canonical",
      path: "$.state_transition.set.x",
    });
  });
});

describe("CORE-10: tool schemas with $id do not kill the run", () => {
  it("two calls through a schema with $id both validate", async () => {
    const s = { $id: "https://example.test/t.json", type: "object", properties: { n: { type: "integer" } } };
    const a = agent({ tools: [tool("t", { input: s, output: OPEN })] });
    const { events } = await run(a, [call("t", { n: 1 }), call("t", { n: 2 })], { t: () => ({ ok: 1 }) });
    assert.equal(events.filter((e) => e.stage === "execute" && e.verdict === "allow").length, 2);
  });
});

describe("Track A transcript strictness (spec-v0.3 §15.1)", () => {
  it("an exhausted transcript is tool_execution_failed / transcript exhausted", async () => {
    const { events } = await run(agent({ tools: [tool("t")] }), [call("t")], { t: () => ({ ok: 1 }) }, { recorded: [] });
    assert.deepEqual(find(events, { reason: "tool_execution_failed" })!.failure, {
      kind: "transcript",
      code: "exhausted",
      call_seq: 1,
    });
  });

  it("a mismatching transcript is tool_execution_failed / transcript mismatch", async () => {
    const { events } = await run(agent({ tools: [tool("t")] }), [call("t", { a: 1 })], {}, {
      recorded: [{ call_seq: 1, tool: "t", args: { a: 2 }, result: { ok: 1 } }],
    });
    assert.deepEqual(find(events, { reason: "tool_execution_failed" })!.failure, {
      kind: "transcript",
      code: "mismatch",
      call_seq: 1,
    });
  });
});

describe("invalid proposals", () => {
  it("two consecutive invalid proposals end the run even with continue_after_deny", async () => {
    const a = agent({ tools: [tool("t")], limits: { continue_after_deny: true } });
    const { events } = await run(a, [
      { type: "invalid", reason: "no_tool_call", message: "I think…" },
      { type: "invalid", reason: "no_tool_call" },
      call("t"),
    ]);
    assert.equal(events.length, 2);
    assert.deepEqual(events[0]!.observation, { invalid_reason: "no_tool_call", stop_message: "I think…" });
    assert.equal(events[0]!.error, undefined);
  });

  it("silence is empty_proposal; a malformed call is invalid_proposal (never mapped to stop)", async () => {
    const a = agent({ tools: [tool("t")], limits: { continue_after_deny: true } });
    const { events } = await run(a, [
      { type: "invalid", reason: "invalid_tool_arguments_json" },
      call("t"),
      { type: "invalid", reason: "empty_proposal" },
    ], { t: () => ({ ok: 1 }) });
    assert.equal(events[0]!.reason, "invalid_proposal");
    assert.deepEqual(events[0]!.observation, { invalid_reason: "invalid_tool_arguments_json", stop_message: null });
    assert.equal(events.find((e) => e.reason === "empty_proposal")?.stage, "propose");
  });
});

describe("the engine enforces limits itself (spec-v0.3 §5.2)", () => {
  it("a host step cap ends the run with a visible limit_exceeded, not a silent stop", async () => {
    const a = agent({ tools: [tool("t")] });
    const { events } = await run(a, [call("t"), call("t"), call("t")], { t: () => ({ ok: 1 }) }, { iterations: 2 });
    assert.equal(events.filter((e) => e.stage === "execute").length, 2);
    assert.deepEqual(
      { stage: events.at(-1)!.stage, verdict: events.at(-1)!.verdict, reason: events.at(-1)!.reason },
      { stage: "authorize", verdict: "deny", reason: "limit_exceeded" },
    );
  });

  it("without a host cap the harness max_steps governs", async () => {
    const a = agent({ tools: [tool("t")], limits: { max_steps: 1 } });
    const queue = [call("t"), call("t")];
    const rt = new FaustRuntime({ agent: a, propose: async () => queue.shift() ?? { type: "stop" }, tools: { t: () => ({ ok: 1 }) } });
    await rt.runLoop();
    assert.equal(rt.events.filter((e) => e.stage === "execute").length, 1);
    assert.equal(rt.events.at(-1)!.reason, "limit_exceeded");
  });
});

describe("harness hash (spec-v0.3 §12)", () => {
  it("is computed over the declared IR, independent of run-time state", async () => {
    const a = agent({
      state: { seen: 0 },
      mutable: ["skills"],
      tools: [tool("read"), tool("harness.propose_skills_patch")],
    });
    const { events } = await run(
      a,
      [call("read"), call("harness.propose_skills_patch", { ops: [{ op: "set_tool_description", tool_id: "read", description: "Read carefully" }] })],
      {
        read: () => ({ output: { ok: 1 }, state_transition: { set: { seen: 1 } } }),
        "harness.propose_skills_patch": () => ({ ok: 1 }),
      },
    );
    const reb = find(events, { stage: "rebalance" })!;
    assert.equal(reb.harness_hash_before, harnessIrHash(a));
  });
});
