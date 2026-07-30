import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  phaseYielded,
  planApproved,
  shouldStartImplementation,
} from "./case-study-pipeline.mjs";

function line(obj) {
  return JSON.stringify(obj);
}

describe("case-study pipeline host gates", () => {
  it("detects phase.yield and user.approve execute allows", () => {
    const events = [
      line({ stage: "orient", verdict: "allow" }),
      line({ stage: "execute", tool: "fs.read", verdict: "allow" }),
      line({ stage: "execute", tool: "user.approve", verdict: "allow" }),
      line({ stage: "execute", tool: "phase.yield", verdict: "allow" }),
    ].join("\n");
    assert.equal(planApproved(events), true);
    assert.equal(phaseYielded(events), true);
    assert.equal(shouldStartImplementation(events), true);
  });

  it("refuses implementation when plan was not approved", () => {
    const events = [
      line({ stage: "execute", tool: "fs.read", verdict: "allow" }),
      line({ stage: "execute", tool: "phase.yield", verdict: "allow" }),
    ].join("\n");
    assert.equal(planApproved(events), false);
    assert.equal(shouldStartImplementation(events), false);
  });

  it("ignores denied approve attempts", () => {
    const events = line({
      stage: "execute",
      tool: "user.approve",
      verdict: "deny",
    });
    assert.equal(shouldStartImplementation(events), false);
  });
});
