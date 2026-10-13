import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { auditEvents, auditJsonlFile, formatAuditHuman } from "./audit.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("audit", () => {
  it("aggregates capability_missing from write-before-plan fixture", () => {
    const path = join(root, "conformance/fixtures/cb-write-before-plan-denied/expected.jsonl");
    const s = auditJsonlFile(path);
    assert.equal(s.denies, 1);
    assert.equal(s.by_reason.sequence_requirement_failed, 1);
    assert.equal(s.structured_failures.missing_prior_tools, 1);
  });

  it("flags verify_output_failed", () => {
    const path = join(root, "conformance/fixtures/cb-chat-solution-absence-denied/expected.jsonl");
    const s = auditJsonlFile(path);
    assert.equal(s.verify_output_failed, 1);
    assert.equal(s.denies, 1);
  });

  it("counts memory_stale and budget_exceeded telemetry", () => {
    const stale = auditJsonlFile(
      join(root, "conformance/fixtures/cb-stale-after-ttl/expected.jsonl"),
    );
    assert.ok(stale.memory_stale >= 1);
    const budget = auditJsonlFile(
      join(root, "conformance/fixtures/cb-budget-exceeded/expected.jsonl"),
    );
    assert.equal(budget.budget_exceeded, 1);
  });

  it("CORE-18: counts an authorize-stage deny retried and denied again as a near-miss", () => {
    // propose → validate:allow → authorize:deny, twice in a row, with orientation in between.
    const attempt = [
      { stage: "orient", verdict: "allow" },
      { stage: "propose", tool: "fs.write_scoped" },
      { stage: "validate", verdict: "allow", tool: "fs.write_scoped" },
      { stage: "authorize", verdict: "deny", reason: "sequence_requirement_failed", tool: "fs.write_scoped" },
    ];
    assert.equal(auditEvents([...attempt, ...attempt]).near_misses, 1);
    assert.equal(auditEvents([...attempt, ...attempt, ...attempt]).near_misses, 2);
  });

  it("CORE-18: a different tool or a success in between is not a near-miss", () => {
    const deny = (tool: string) => [
      { stage: "propose", tool },
      { stage: "validate", verdict: "deny", reason: "capability_missing", tool },
    ];
    const ok = [
      { stage: "propose", tool: "fs.read" },
      { stage: "validate", verdict: "allow", tool: "fs.read" },
      { stage: "authorize", verdict: "allow", tool: "fs.read" },
      { stage: "execute", verdict: "allow", tool: "fs.read" },
      { stage: "verify", verdict: "allow" },
    ];
    assert.equal(auditEvents([...deny("a"), ...deny("b")]).near_misses, 0);
    assert.equal(auditEvents([...deny("a"), ...ok, ...deny("a")]).near_misses, 0);
  });

  it("CORE-18: child-reaction events do not break or fake a parent pairing", () => {
    const parentDeny = [
      { stage: "propose", tool: "x" },
      { stage: "authorize", verdict: "deny", reason: "gate_denied", tool: "x" },
    ];
    const child = [
      { stage: "propose", tool: "x", depth: 1, spawn_id: "spawn-9" },
      { stage: "validate", verdict: "allow", tool: "x", depth: 1, spawn_id: "spawn-9" },
    ];
    assert.equal(auditEvents([...parentDeny, ...child, ...parentDeny]).near_misses, 1);
  });

  it("formats human summary", () => {
    const s = auditEvents([{ verdict: "deny", reason: "capability_missing", tool: "x" }]);
    const text = formatAuditHuman(s);
    assert.match(text, /capability_missing: 1/);
  });
});
