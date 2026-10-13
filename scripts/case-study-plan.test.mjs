/** SCR-8 / SCR-16: plan accounting and curriculum task order. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attemptId,
  buildPlan,
  curriculumTransfer,
  expandAdaptiveTries,
  planAccounting,
  priorChainSuccess,
  skippedAfterSuccessRow,
} from "./lib/case-study-plan.mjs";

const manifest = {
  harnesses: { counterbalanced: "x", "cb-mutable": "y", "mutable-skills": "z", baseline: "b" },
  deployments: { recorded: { path: "dep.yml" } },
  matrix: {
    repetitions: 2,
    conditions: ["counterbalanced", "cb-mutable"],
    recorded_provider_labels: ["kit"],
    live_deployments: [],
    max_task_tries: 3,
  },
  tasks: ["t1", "t2", "t3", "t4"].map((id) => ({ id, path: `tasks/${id}`, category: "c" })),
};

describe("curriculum task order (SCR-16)", () => {
  it("stores the shuffled order and position on every item", () => {
    const plan = buildPlan(manifest, "recorded", {
      curriculum: true,
      shuffleCurriculum: true,
      curriculumShuffleSeed: 5,
      conditions: ["counterbalanced"],
    });
    const rep1 = plan.filter((p) => p.rep === 1);
    const rep2 = plan.filter((p) => p.rep === 2);
    assert.deepEqual(rep1.map((p) => p.task_id), rep1[0].task_order, "walk order = stored order");
    assert.deepEqual(rep2.map((p) => p.task_id), rep2[0].task_order);
    assert.notDeepEqual(rep1[0].task_order, rep2[0].task_order, "reps are shuffled differently");
    rep2.forEach((p, i) => assert.equal(p.task_position, i));
  });

  it("splits early/late by the order that ran, not the manifest order", () => {
    const plan = buildPlan(manifest, "recorded", {
      curriculum: true,
      shuffleCurriculum: true,
      curriculumShuffleSeed: 5,
      conditions: ["counterbalanced"],
      reps: 1,
    });
    // Succeed exactly on the tasks walked FIRST (early half of the run order).
    const attempts = plan.map((p) => ({
      ...p,
      status: "scored",
      score: { task_success: p.task_position < 2 },
    }));
    const order = plan[0].task_order;
    assert.notDeepEqual(order, ["t1", "t2", "t3", "t4"], "fixture must actually shuffle");
    const ct = curriculumTransfer(attempts).counterbalanced;
    assert.equal(ct.early.rate, 1);
    assert.equal(ct.late.rate, 0);
    assert.equal(ct.late_minus_early, -1);
    assert.deepEqual(ct.task_orders.rep1, order);
  });
});

describe("adaptive try accounting (SCR-8)", () => {
  it("accounts tries skipped after an early success", () => {
    const plan = expandAdaptiveTries(
      buildPlan(manifest, "recorded", { conditions: ["cb-mutable"], reps: 1, taskIds: ["t1"] }),
      manifest,
    );
    assert.equal(plan.length, 3);
    /** @type {Array<Record<string, any>>} */
    const attempts = [];
    for (const item of plan) {
      const prior = priorChainSuccess(item, attempts);
      if (prior) {
        attempts.push(skippedAfterSuccessRow(item, prior));
        continue;
      }
      attempts.push({
        ...item,
        attempt_id: attemptId(item),
        status: "scored",
        score: { task_success: item.try_index === 1 },
      });
    }
    assert.deepEqual(
      attempts.map((a) => a.status),
      ["scored", "skipped_after_success", "skipped_after_success"],
    );
    assert.equal(attempts[1].parent_attempt_id, attempts[0].attempt_id);
    const acc = planAccounting(plan, attempts);
    assert.equal(acc.complete, true, "plan fully accounted ⇒ no spurious exit 1");
    assert.equal(acc.accounted, 3);
    assert.deepEqual(acc.by_status, { scored: 1, skipped_after_success: 2 });
  });

  it("reports unaccounted plan items", () => {
    const plan = expandAdaptiveTries(
      buildPlan(manifest, "recorded", { conditions: ["counterbalanced"], reps: 1, taskIds: ["t1", "t2"] }),
      manifest,
    );
    const acc = planAccounting(plan, [{ attempt_id: attemptId(plan[0]), status: "scored" }]);
    assert.equal(acc.complete, false);
    assert.deepEqual(acc.missing, [attemptId(plan[1])]);
  });
});
