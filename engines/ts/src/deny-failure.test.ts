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
    { id: "user.correct", input: { type: "object" }, output: { type: "object" } },
    { id: "task.complete", input: { type: "object" }, output: { type: "object" } },
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
});
