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
  attributionMarkdown,
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

  it("taskChainId separates train passes and eval slots", () => {
    const base = { task_id: "t", condition: "mutable-skills", deployment_id: "kit", model_id: "m", rep: 1 };
    const p1 = taskChainId({ ...base, phase: "train", train_pass: 1 });
    const p2 = taskChainId({ ...base, phase: "train", train_pass: 2 });
    assert.notEqual(p1, p2);
    assert.notEqual(taskChainId({ ...base, phase: "eval" }), taskChainId(base));
  });
});

/** Adaptive chain rows: outcomes per try (true/false/"skip"). */
function chainRows(condition, task, outcomes, { k = 5, rep = 1 } = {}) {
  const chain = `${task}__${condition}__kit__m__rep${rep}`;
  return outcomes.map((o, i) => ({
    attempt_id: `${chain}__try${i + 1}`,
    condition,
    task_id: task,
    rep,
    model_id: "m",
    deployment_id: "kit",
    task_chain_id: chain,
    try_index: i + 1,
    max_task_tries: k,
    parent_attempt_id: i === 0 ? null : `${chain}__try${i}`,
    status: o === "skip" ? "skipped_after_success" : "scored",
    score: o === "skip" ? null : { task_success: o === true },
  }));
}

function singleRow(condition, task, success, rep = 1) {
  return {
    attempt_id: `${task}__${condition}__kit__m__rep${rep}`,
    condition,
    task_id: task,
    rep,
    model_id: "m",
    deployment_id: "kit",
    task_chain_id: `${task}__${condition}__kit__m__rep${rep}`,
    try_index: null,
    max_task_tries: 1,
    status: "scored",
    score: { task_success: success },
  };
}

describe("checkOptInvariants (SCR-7 / SCR-8)", () => {
  it("does not flag single-try (try_index: null) rows as gaps", () => {
    const r = checkOptInvariants([
      singleRow("counterbalanced", "a", true),
      singleRow("counterbalanced", "b", false),
      singleRow("cb-budget", "a", false),
    ]);
    assert.deepEqual(r.violations, []);
    assert.equal(r.ok, true);
  });

  it("accepts tries skipped after an early success", () => {
    const r = checkOptInvariants(chainRows("cb-mutable", "a", [false, true, "skip", "skip", "skip"]));
    assert.deepEqual(r.violations, []);
  });

  it("flags tries run after a success and skips without a success", () => {
    const ran = checkOptInvariants(chainRows("cb-mutable", "a", [true, false]));
    assert.ok(ran.violations.some((v) => /ran after success/.test(v)));
    const skippedEarly = checkOptInvariants(chainRows("cb-mutable", "b", [false, "skip"]));
    assert.ok(skippedEarly.violations.some((v) => /skipped without a prior success/.test(v)));
  });
});

describe("attribution (SCR-5 / CASE-16)", () => {
  it("compares pass@1 with pass@1 and labels pass@k separately", () => {
    const attempts = [
      ...chainRows("cb-mutable", "a", [false, true, "skip", "skip", "skip"]),
      ...chainRows("cb-mutable", "b", [false, false, false, false, false]),
      singleRow("counterbalanced", "a", false),
      singleRow("counterbalanced", "b", false),
    ];
    const stats = adaptiveArmStats(attempts, "cb-mutable");
    assert.equal(stats.pass_at_1.p, 0);
    assert.equal(stats.pass_at_k.k, 5);
    assert.equal(stats.pass_at_k.p, 0.5);
    const md = attributionMarkdown({
      track: "S",
      attempts,
      baselineCondition: "counterbalanced",
      invariants: checkOptInvariants(attempts),
    });
    const row = md.split("\n").find((l) => l.startsWith("| cb-mutable"));
    assert.ok(row, md);
    const cells = row.split("|").map((c) => c.trim());
    assert.equal(cells[3], "0.0% (0/2)", "pass@1 column");
    assert.equal(cells[4], "+0.0", "Δ is pass@1 − pass@1, not pass@5 − pass@1");
    assert.equal(cells[5], "2", "matched units");
    assert.match(cells[8], /50\.0% \(k=5\)/);
    assert.doesNotMatch(md, /INVARIANTS FAILED/);
  });

  it("refuses Δ when the baseline arm is absent", () => {
    const attempts = chainRows("cb-optimize", "a", [false, true, "skip", "skip", "skip"]);
    const md = attributionMarkdown({
      track: "T",
      attempts,
      baselineCondition: "counterbalanced",
      invariants: checkOptInvariants(attempts),
    });
    assert.match(md, /absent from this run/);
    const row = md.split("\n").find((l) => l.startsWith("| cb-optimize"));
    assert.match(row, /n\/a \(baseline arm absent\)/);
    assert.doesNotMatch(row, /\+100\.0/);
  });

  it("surfaces failed invariants loudly (CASE-16)", () => {
    const attempts = chainRows("cb-mutable", "a", [true, false]);
    const md = attributionMarkdown({
      track: "S",
      attempts,
      invariants: checkOptInvariants(attempts),
    });
    assert.match(md, /INVARIANTS FAILED/);
    assert.ok(md.indexOf("INVARIANTS FAILED") < md.indexOf("| Arm |"), "banner precedes the table");
  });
});

