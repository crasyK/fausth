import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCheckpointKeyFailure,
  buildMissingPriorAnyOfFailure,
  buildMissingPriorToolsFailure,
  buildPredicateFailure,
} from "./deny-failure.js";
import { FaustRuntime } from "./runtime.js";
import { createCodingTools } from "./tools/world.js";
import type { AgentIR, ModelProposal } from "./types.js";

const agent: AgentIR = {
  name: "impl",
  state: { open_todos: 1, test_evidence_current: 1 },
  tools: [
    {
      id: "user.correct",
      input: { type: "object", additionalProperties: true },
      output: { type: "object", additionalProperties: true },
    },
    {
      id: "task.complete",
      input: { type: "object", additionalProperties: true },
      output: { type: "object", additionalProperties: true },
    },
  ],
  permissions: { tools: ["user.correct", "task.complete"] },
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
    checkpoints: [{ tool: "user.correct", allow_set_keys: ["open_todos"] }],
  },
  limits: { max_steps: 4 },
};

describe("deny failure builders", () => {
  it("buildPredicateFailure includes unblock from checkpoints", () => {
    const snap = { state: { open_todos: 1 } };
    const failure = buildPredicateFailure(
      { path: "state.open_todos", eq: 0 },
      snap,
      [{ tool: "user.correct", allow_set_keys: ["open_todos"] }],
    );
    assert.equal(failure.kind, "predicate");
    assert.equal(failure.failed[0]?.path, "state.open_todos");
    assert.equal(failure.failed[0]?.current, 1);
    assert.deepEqual(failure.failed[0]?.require, { eq: 0 });
    assert.deepEqual(failure.failed[0]?.unblock, {
      tool: "user.correct",
      set_key: "open_todos",
      set_value: 0,
    });
  });

  it("buildMissingPriorToolsFailure sorts tools", () => {
    const failure = buildMissingPriorToolsFailure(["user.approve", "fs.read"]);
    assert.deepEqual(failure, {
      kind: "missing_prior_tools",
      missing_prior_tools: ["fs.read", "user.approve"],
    });
  });

  it("buildMissingPriorAnyOfFailure sorts options", () => {
    assert.deepEqual(buildMissingPriorAnyOfFailure(["b", "a"]), {
      kind: "missing_prior_any_of",
      options: ["a", "b"],
    });
  });

  it("buildCheckpointKeyFailure names protected key", () => {
    assert.deepEqual(buildCheckpointKeyFailure("plan_approved"), {
      kind: "checkpoint_key",
      checkpoint_key: "plan_approved",
    });
  });
});

describe("completion deny failure", () => {
  it("emits structured failure when open_todos blocks task.complete", async () => {
    const proposals: ModelProposal[] = [{ type: "tool", name: "task.complete", args: {} }];
    const rt = new FaustRuntime({
      agent: structuredClone(agent),
      propose: async () => proposals.shift() ?? { type: "stop" },
      tools: createCodingTools(),
    });
    await rt.runLoop(2);
    const deny = rt.events.find(
      (e) => e.stage === "authorize" && e.reason === "completion_gate_failed",
    );
    assert.ok(deny?.failure);
    assert.equal(deny!.failure!.kind, "predicate");
    if (deny!.failure!.kind !== "predicate") return;
    const openTodos = deny!.failure!.failed.find((f) => f.path === "state.open_todos");
    assert.ok(openTodos);
    assert.equal(openTodos!.unblock?.tool, "user.correct");
  });

  it("stops the run after the first successful task.complete", async () => {
    const proposals: ModelProposal[] = [
      { type: "tool", name: "task.complete", args: {} },
      { type: "tool", name: "task.complete", args: {} },
      { type: "tool", name: "task.complete", args: {} },
    ];
    const a = structuredClone(agent);
    a.state.open_todos = 0;
    a.state.test_evidence_current = 1;
    const rt = new FaustRuntime({
      agent: a,
      propose: async () => proposals.shift() ?? { type: "stop" },
      tools: createCodingTools(),
    });
    await rt.runLoop(10);
    const completeExecs = rt.events.filter(
      (e) => e.tool === "task.complete" && e.stage === "execute" && e.verdict === "allow",
    );
    assert.equal(completeExecs.length, 1);
    const done = rt.events.find((e) => e.stage === "record" && e.reason === "run_complete");
    assert.ok(done);
    assert.equal(proposals.length, 2);
  });

  it("stops the run after the first successful phase.yield", async () => {
    const proposals: ModelProposal[] = [
      { type: "tool", name: "phase.yield", args: {} },
      { type: "tool", name: "phase.yield", args: {} },
      { type: "tool", name: "fs.read", args: { path: "README.md" } },
    ];
    const a: AgentIR = {
      name: "research",
      state: { researched: 0, phase_yielded: 0 },
      tools: [
        {
          id: "fs.read",
          input: { type: "object", additionalProperties: true },
          output: { type: "object", additionalProperties: true },
        },
        {
          id: "phase.yield",
          input: { type: "object", additionalProperties: true },
          output: { type: "object", additionalProperties: true },
        },
      ],
      permissions: { tools: ["fs.read", "phase.yield"] },
      limits: { max_steps: 10 },
    };
    const rt = new FaustRuntime({
      agent: a,
      propose: async () => proposals.shift() ?? { type: "stop" },
      tools: createCodingTools(),
    });
    await rt.runLoop(10);
    const yieldExecs = rt.events.filter(
      (e) => e.tool === "phase.yield" && e.stage === "execute" && e.verdict === "allow",
    );
    assert.equal(yieldExecs.length, 1);
    const done = rt.events.find((e) => e.stage === "record" && e.reason === "phase_yielded");
    assert.ok(done);
    assert.equal(proposals.length, 2);
  });
});
