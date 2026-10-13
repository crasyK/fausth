/**
 * Host pipeline gates under contract v0.3: completion is the engine's
 * run_complete record; a call succeeds only when executed AND verified (D8).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  phaseCompleted,
  planApproved,
  runCompleted,
  shouldStartImplementation,
  successfulCalls,
} from "./case-study-pipeline.mjs";

function line(obj) {
  return JSON.stringify(obj);
}

/** One governed call in v0.3 event shape. */
function call(tool, { result = { ok: 1 }, verify = "allow", args = {} } = {}) {
  return [
    line({ stage: "propose", tool, args }),
    line({ stage: "validate", verdict: "allow", tool }),
    line({ stage: "authorize", verdict: "allow", tool }),
    line({ stage: "execute", verdict: "allow", tool, result }),
    line({ stage: "verify", verdict: verify }),
  ];
}

describe("case-study pipeline host gates (v0.3)", () => {
  it("detects an approved plan and the phase's run_complete", () => {
    const events = [
      line({ stage: "orient", verdict: "allow" }),
      ...call("fs.read"),
      ...call("user.approve", { result: { approved: 1 } }),
      ...call("phase.yield"),
      line({ stage: "record", verdict: "allow", reason: "run_complete", tool: "phase.yield" }),
    ].join("\n");
    assert.equal(planApproved(events), true);
    assert.equal(phaseCompleted(events), true);
    assert.equal(runCompleted(events, "phase.yield"), true);
    assert.equal(runCompleted(events, "task.complete"), false);
    assert.equal(shouldStartImplementation(events), true);
    assert.deepEqual(
      successfulCalls(events).map((c) => c.tool),
      ["fs.read", "user.approve", "phase.yield"],
    );
  });

  it("refuses implementation when plan was not approved", () => {
    const events = [...call("fs.read"), ...call("phase.yield")].join("\n");
    assert.equal(planApproved(events), false);
    assert.equal(shouldStartImplementation(events), false);
  });

  it("ignores denied approve attempts", () => {
    const events = [
      line({ stage: "propose", tool: "user.approve", args: {} }),
      line({ stage: "authorize", tool: "user.approve", verdict: "deny", reason: "capability_missing" }),
    ].join("\n");
    assert.equal(shouldStartImplementation(events), false);
  });

  it("an executed but unverified call is not a success (D8)", () => {
    const events = call("user.approve", { result: { approved: 1 }, verify: "deny" }).join("\n");
    assert.equal(planApproved(events), false);
    assert.deepEqual(successfulCalls(events), []);
  });

  it("a user answer of approved: 0 does not approve the plan", () => {
    const events = call("user.approve", { result: { approved: 0 } }).join("\n");
    assert.equal(planApproved(events), false);
  });

  it("a yield tool that executed without run_complete did not complete the phase", () => {
    const events = call("phase.yield").join("\n");
    assert.equal(phaseCompleted(events), false);
  });
});
