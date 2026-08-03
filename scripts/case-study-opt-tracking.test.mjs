/**
 * Unit tests for harness-optimize tracking helpers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isAdaptiveCondition,
  taskChainId,
  checkOptInvariants,
  adaptiveArmStats,
  buildOptimizeDigest,
} from "./case-study-opt-tracking.mjs";

describe("case-study-opt-tracking", () => {
  it("flags adaptive conditions", () => {
    assert.equal(isAdaptiveCondition("cb-mutable"), true);
    assert.equal(isAdaptiveCondition("cb-optimize"), true);
    assert.equal(isAdaptiveCondition("cb-budget"), false);
    assert.equal(isAdaptiveCondition("counterbalanced"), false);
  });

  it("builds stable task_chain_id", () => {
    const id = taskChainId({
      task_id: "retail-000",
      condition: "cb-mutable",
      deployment_id: "kit",
      model_id: "kit.gemma4-31b-it",
      rep: 1,
    });
    assert.match(id, /^retail-000__cb-mutable__kit__/);
  });

  it("buildOptimizeDigest includes outcome section", () => {
    const md = buildOptimizeDigest({
      eventsText: '{"tool":"fs.read","stage":"execute","verdict":"allow"}\n',
      report: { pipeline_blocked: "plan_not_approved", completion_reached: false },
      grade: { ground_truth_pass: false },
      score: { task_success: false, discovery_failure: true },
    });
    assert.match(md, /plan_not_approved/);
    assert.match(md, /Optimize digest/);
  });

  it("buildOptimizeDigest extracts tau unknown-tool errors and track hints", () => {
    const events =
      '{"tool":"shell.run_allowlisted","stage":"execute","verdict":"allow","result":{"stdout":"Error: unknown tool get_user_id"}}\n' +
      '{"tool":"shell.run_allowlisted","stage":"execute","verdict":"allow","result":{"stdout":"Error: unknown tool search_user"}}\n';
    const md = buildOptimizeDigest({
      eventsText: events,
      report: { completion_reached: false },
      grade: { ground_truth_pass: false },
      score: { task_success: false, false_completion: true },
      hints: "## tau API reference\nValid tools: find_user_id_by_name_zip",
    });
    assert.match(md, /## Track hints/);
    assert.match(md, /find_user_id_by_name_zip/);
    assert.match(md, /## tau stdout errors/);
    assert.match(md, /unknown tool get_user_id/);
    assert.match(md, /unknown tool search_user/);
  });

  it("checkOptInvariants catches try gaps", () => {
    const r = checkOptInvariants([
      {
        task_chain_id: "c1",
        try_index: 1,
        status: "scored",
        score: { task_success: false },
      },
      {
        task_chain_id: "c1",
        try_index: 3,
        parent_attempt_id: "x",
        status: "scored",
        score: { task_success: false },
      },
    ]);
    assert.equal(r.ok, false);
    assert.ok(r.never_reset_violations >= 1);
  });

  it("adaptiveArmStats any-of success", () => {
    const stats = adaptiveArmStats(
      [
        {
          condition: "cb-mutable",
          task_chain_id: "t1",
          try_index: 1,
          status: "scored",
          score: { task_success: false },
        },
        {
          condition: "cb-mutable",
          task_chain_id: "t1",
          try_index: 2,
          status: "scored",
          score: { task_success: true },
          selection_ok: true,
        },
      ],
      "cb-mutable",
    );
    assert.equal(stats.task_success_any_of.successes, 1);
    assert.equal(stats.task_success_first_try.successes, 0);
    assert.equal(stats.mean_tries_to_success, 2);
  });
});
