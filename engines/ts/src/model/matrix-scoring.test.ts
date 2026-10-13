import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateLeaderboard,
  classifyCellError,
  emptyScore,
  scoreFindings,
  type ScoredCell,
} from "./matrix-scoring.js";
import { ModelInfraError } from "./errors.js";
import { toRuntimeProposal } from "./port.js";

describe("model matrix scoring (EDGE-21)", () => {
  it("classifies transport infra failures and setup errors — never as model failures", () => {
    const rl = classifyCellError(new ModelInfraError("rate_limit", "slow down", { status: 429 }));
    assert.deepEqual(rl, { error_class: "infra", infra_kind: "rate_limit", conclusion: "neutral" });
    const to = classifyCellError(new ModelInfraError("timeout", "timed out"));
    assert.equal(to.error_class, "infra");
    assert.equal(to.conclusion, "infrastructure_error");
    const setup = classifyCellError(new Error("fixture x deterministic=fail expected pass"));
    assert.equal(setup.error_class, "setup");
  });

  it("excludes errored cells from TP/FP/FN/TN and from precision/recall denominators", () => {
    const tp = scoreFindings(
      { label: "x", expected_deterministic: "pass", expect_categories_any: ["contradiction"] },
      [
        {
          category: "contradiction",
          severity: "warning",
          path: "projects/p/README.md",
          evidence: "e",
          recommendation: "r",
        },
      ],
    );
    assert.equal(tp.tp, 1);
    const cells: ScoredCell[] = [
      { model: "m", ok: true, score: tp },
      { model: "m", ok: false, score: emptyScore("rate limited"), error_class: "infra" },
      { model: "m", ok: false, score: emptyScore("bad fixture"), error_class: "setup" },
    ];
    const [row] = aggregateLeaderboard(cells);
    assert.ok(row);
    assert.equal(row.cells, 3);
    assert.equal(row.scored_cells, 1);
    assert.equal(row.infra_errors, 1);
    assert.equal(row.setup_errors, 1);
    assert.equal(row.fn, 0, "an outage is not a missed finding");
    assert.equal(row.recall, 1);
    assert.equal(row.usefulness, 1);
  });

  it("a model with only infra failures has no recall (null), not recall 0", () => {
    const [row] = aggregateLeaderboard([
      { model: "down", ok: false, score: emptyScore(), error_class: "infra" },
    ]);
    assert.equal(row!.recall, null);
    assert.equal(row!.precision, null);
    assert.equal(row!.scored_cells, 0);
  });
});

describe("toRuntimeProposal", () => {
  it("keeps invalid as invalid (not a stop)", () => {
    const out = toRuntimeProposal({ type: "invalid", reason: "multiple_tool_calls", raw: "[...]" });
    assert.deepEqual(out, { type: "invalid", reason: "multiple_tool_calls", message: "[...]" });
  });
  it("maps tool and stop", () => {
    assert.deepEqual(toRuntimeProposal({ type: "tool", name: "a.b", args: { x: 1 }, model: "m" }), {
      type: "tool",
      name: "a.b",
      args: { x: 1 },
    });
    assert.deepEqual(toRuntimeProposal({ type: "stop", message: "bye" }), { type: "stop", message: "bye" });
  });
});
