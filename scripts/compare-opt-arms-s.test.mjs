/** SCR-5 / CASE-13: opt-arm comparison is pass@1 vs pass@1, paired, and read-only. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { compareVersion, formatRows, loadArmSummary } from "./compare-opt-arms-s.mjs";

const chain = (condition, task, outcomes, k = 5) =>
  outcomes.map((o, i) => ({
    task_id: task,
    condition,
    rep: 1,
    model_id: "kit.glm-5.3-flash",
    deployment_id: "kit",
    try_index: k > 1 ? i + 1 : null,
    max_task_tries: k,
    task_chain_id: `${task}__${condition}`,
    status: o === "skip" ? "skipped_after_success" : "scored",
    score: o === "skip" ? null : { task_success: o === true },
  }));

describe("compare-opt-arms-s", () => {
  let base = "";
  before(() => {
    base = mkdtempSync(join(tmpdir(), "fausth-cmp-"));
    const write = (name, attempts) => {
      const dir = join(base, "live/reports/case-studies/swe-bench", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "summary.json"), JSON.stringify({ attempts, invariants: { ok: true } }));
    };
    write("hri-swe-opt-arms-v9-baseline", [
      ...chain("counterbalanced", "a", [false], 1),
      ...chain("counterbalanced", "b", [false], 1),
    ]);
    write("hri-swe-opt-arms-v9-mutable", [
      ...chain("cb-mutable", "a", [false, true, "skip", "skip", "skip"]),
      ...chain("cb-mutable", "b", [false, false, false, false, true]),
    ]);
    write("hri-swe-opt-arms-v8-mutable", chain("cb-mutable", "a", [true, "skip", "skip", "skip", "skip"]));
  });
  after(() => rmSync(base, { recursive: true, force: true }));

  const load = (prefix) =>
    Object.fromEntries(
      ["baseline", "budget", "mutable", "optimize"].map((arm) => [arm, loadArmSummary("swe", prefix, arm, base)]),
    );

  it("reports pass@1 with a paired Δ vs baseline; pass@k separately with k", () => {
    const rows = compareVersion(load("v9"));
    const mut = rows.find((r) => r.arm === "mutable");
    assert.equal(mut.pass_at_1.p, 0, "first tries all failed");
    assert.equal(mut.pass_at_k.k, 5);
    assert.equal(mut.pass_at_k.p, 1);
    assert.equal(mut.delta.status, "ok");
    assert.equal(mut.delta.absolute, 0, "Δ is pass@1 − pass@1, not pass@5 − pass@1");
    assert.equal(mut.delta.n_matched, 2);
    const text = formatRows("v9", rows);
    assert.match(text, /mutable\s+\t0\.0% \(0\/2\)\t\+0\.0/);
    assert.match(text, /100\.0% \(k=5\)/);
  });

  it("refuses Δ without a baseline arm and never writes results", () => {
    const rows = compareVersion(load("v8"));
    assert.equal(rows.find((r) => r.arm === "mutable").delta.status, "missing_arm");
    assert.equal(rows.find((r) => r.arm === "baseline").missing, true);
    assert.deepEqual(readdirSync(base), ["live"], "comparison is read-only");
  });
});
