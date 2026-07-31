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

  it("formats human summary", () => {
    const s = auditEvents([{ verdict: "deny", reason: "capability_missing", tool: "x" }]);
    const text = formatAuditHuman(s);
    assert.match(text, /capability_missing: 1/);
  });
});
