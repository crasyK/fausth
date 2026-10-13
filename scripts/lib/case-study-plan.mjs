/**
 * Case-study plan construction and bookkeeping (pure helpers, no I/O).
 *
 * Every plan item records the task order of its (condition, rep) lineage and its
 * position in it (SCR-16), so curriculum early/late splits are computed from the
 * order that actually ran, not from the manifest order.
 */
import {
  DEFAULT_MAX_TASK_TRIES,
  isAdaptiveCondition,
  taskChainId,
} from "../case-study-opt-tracking.mjs";

/** @param {unknown} s */
export function sanitizeIdPart(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]+/g, "_");
}

/** @param {Record<string, any>} a */
export function attemptId(a) {
  const parts = [
    a.task_id,
    a.condition,
    a.deployment_id,
    sanitizeIdPart(a.model_id),
    `rep${a.rep}`,
  ];
  if (a.phase === "train") parts.push(`train_pass${a.train_pass ?? 1}`);
  else if (a.phase === "eval") parts.push("eval");
  if (a.try_index != null) parts.push(`try${a.try_index}`);
  return parts.join("__");
}

/** @param {unknown[]} arr @param {number} seed */
export function seededShuffle(arr, seed) {
  const a = [...arr];
  let s = seed >>> 0;
  const rand = () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** @param {Record<string, any>} manifest @param {string[] | null | undefined} taskIds */
export function resolveTasks(manifest, taskIds) {
  if (!taskIds?.length) return [...manifest.tasks];
  return taskIds.map((id) => {
    const t = manifest.tasks.find((x) => x.id === id);
    if (!t) throw new Error(`unknown --tasks id: ${id}`);
    return t;
  });
}

/** Lineage key for never-reset / curriculum carry across tasks. */
export function lineageKey(item) {
  return [item.condition, `rep${item.rep}`, item.model_id, item.deployment_id].join("__");
}

/**
 * @param {Record<string, any>} manifest
 * @param {"recorded" | "live"} mode
 * @param {{
 *   reps?: number | null, conditions?: string[] | null, kitModels?: string[] | null,
 *   taskIds?: string[] | null, curriculum?: boolean, trainFreezeEval?: boolean,
 *   trainPasses?: number, shuffleCurriculum?: boolean, curriculumShuffleSeed?: number,
 *   kitDeployment?: (modelId: string) => string,
 * }} [opts]
 */
export function buildPlan(manifest, mode, opts = {}) {
  const reps = Number(opts.reps ?? manifest.matrix.repetitions ?? 3);
  const conditions = opts.conditions?.length ? opts.conditions : manifest.matrix.conditions;
  for (const c of conditions) {
    if (!manifest.harnesses[c] && c !== "frozen-mutable") {
      throw new Error(`unknown condition / harness: ${c}`);
    }
  }
  /** @type {Array<Record<string, any>>} */
  const plan = [];
  const deployments =
    mode === "live"
      ? manifest.matrix.live_deployments.map((id) => ({
          deployment_id: id,
          ...manifest.deployments[id],
        }))
      : manifest.matrix.recorded_provider_labels.map((label) => ({
          deployment_id: label,
          id: "recorded",
          path: manifest.deployments.recorded.path,
          model_id: `recorded-${label}`,
          api_key_env: null,
        }));

  const kitModels = opts.kitModels;
  const tasks = resolveTasks(manifest, opts.taskIds);
  const shuffleSeed = Number(opts.curriculumShuffleSeed ?? 71);

  const pushItem = (task, dep, variant, condition, rep, order, extra = {}) => {
    const ids = order.map((t) => t.id);
    plan.push({
      task_id: task.id,
      task_path: task.path,
      category: task.category,
      condition,
      deployment_id: dep.deployment_id,
      deployment_path: variant.deployment_path,
      model_id: variant.model_id,
      api_key_env: dep.api_key_env,
      rep,
      task_order: ids,
      task_position: ids.indexOf(task.id),
      ...extra,
    });
  };

  for (const dep of deployments) {
    const modelVariants =
      mode === "live" && dep.deployment_id === "kit" && kitModels?.length
        ? kitModels.map((modelId) => ({
            model_id: modelId,
            deployment_path: opts.kitDeployment ? opts.kitDeployment(modelId) : dep.path,
          }))
        : [{ model_id: dep.model_id, deployment_path: dep.path }];

    for (const variant of modelVariants) {
      if (opts.trainFreezeEval) {
        const trainPasses = Number(opts.trainPasses ?? 2);
        for (let rep = 1; rep <= reps; rep++) {
          const order =
            opts.shuffleCurriculum !== false
              ? seededShuffle(tasks, shuffleSeed + rep * 1009)
              : [...tasks];
          for (let pass = 1; pass <= trainPasses; pass++) {
            for (const task of order) {
              pushItem(task, dep, variant, "mutable-skills", rep, order, {
                phase: "train",
                train_pass: pass,
                curriculum: true,
              });
            }
          }
          for (const condition of ["frozen-mutable", "baseline"]) {
            for (const task of order) {
              pushItem(task, dep, variant, condition, rep, order, {
                phase: "eval",
                curriculum: false,
                mutations_frozen: condition === "frozen-mutable",
              });
            }
          }
        }
      } else if (opts.curriculum) {
        for (const condition of conditions) {
          for (let rep = 1; rep <= reps; rep++) {
            const order = opts.shuffleCurriculum
              ? seededShuffle(tasks, shuffleSeed + rep * 1009)
              : [...tasks];
            for (const task of order) {
              pushItem(task, dep, variant, condition, rep, order, { curriculum: true });
            }
          }
        }
      } else {
        for (const task of tasks) {
          for (const condition of conditions) {
            for (let rep = 1; rep <= reps; rep++) {
              pushItem(task, dep, variant, condition, rep, tasks, {});
            }
          }
        }
      }
    }
  }
  return plan;
}

/**
 * Expand adaptive conditions into up to max_task_tries plan rows (early-stop is
 * accounted as `skipped_after_success`, never silently dropped).
 * @param {Array<Record<string, any>>} plan
 * @param {Record<string, any>} manifest
 * @param {{ maxTaskTries?: number | null }} [opts]
 */
export function expandAdaptiveTries(plan, manifest, opts = {}) {
  const maxTries = Number(
    opts.maxTaskTries ?? manifest.matrix?.max_task_tries ?? DEFAULT_MAX_TASK_TRIES,
  );
  /** @type {Array<Record<string, any>>} */
  const out = [];
  for (const item of plan) {
    if (isAdaptiveCondition(String(item.condition)) && maxTries > 1) {
      const chain = taskChainId(item);
      for (let t = 1; t <= maxTries; t++) {
        out.push({
          ...item,
          try_index: t,
          max_task_tries: maxTries,
          task_chain_id: chain,
          never_reset: true,
          curriculum: true,
        });
      }
    } else {
      out.push({
        ...item,
        try_index: item.try_index ?? null,
        max_task_tries: 1,
        task_chain_id: taskChainId(item),
        never_reset: false,
      });
    }
  }
  return out;
}

/** Parent attempt id for try t > 1 of a chain (null otherwise). */
export function parentAttemptId(item) {
  return item.try_index != null && Number(item.try_index) > 1
    ? attemptId({ ...item, try_index: Number(item.try_index) - 1 })
    : null;
}

/**
 * The earlier successful try of `item`'s chain, if any.
 * @param {Record<string, any>} item
 * @param {Array<Record<string, any>>} attempts
 */
export function priorChainSuccess(item, attempts) {
  if (item.try_index == null || Number(item.try_index) <= 1) return null;
  return (
    attempts.find(
      (a) =>
        a.task_chain_id === item.task_chain_id &&
        Number(a.try_index) < Number(item.try_index) &&
        a.status === "scored" &&
        a.score?.task_success === true,
    ) ?? null
  );
}

/**
 * Ledger row for a try that is not run because the chain already succeeded (SCR-8).
 * @param {Record<string, any>} item
 * @param {Record<string, any>} success the successful earlier try
 */
export function skippedAfterSuccessRow(item, success) {
  return {
    attempt_id: attemptId(item),
    task_id: item.task_id,
    category: item.category,
    condition: item.condition,
    deployment_id: item.deployment_id,
    model_id: item.model_id,
    rep: item.rep,
    phase: item.phase ?? null,
    train_pass: item.train_pass ?? null,
    try_index: item.try_index ?? null,
    max_task_tries: item.max_task_tries ?? null,
    parent_attempt_id: parentAttemptId(item),
    task_chain_id: item.task_chain_id ?? null,
    task_position: item.task_position ?? null,
    status: "skipped_after_success",
    skipped_reason: `chain succeeded on try ${success.try_index}`,
    succeeded_attempt_id: success.attempt_id ?? null,
    score: null,
    artifacts: {},
  };
}

/**
 * Plan accounting: every planned item must have exactly one ledger row.
 * @param {Array<Record<string, any>>} plan
 * @param {Array<Record<string, any>>} attempts
 */
export function planAccounting(plan, attempts) {
  const planned = new Set(plan.map(attemptId));
  const accounted = new Set(attempts.map((a) => String(a.attempt_id)));
  const missing = [...planned].filter((id) => !accounted.has(id));
  /** @type {Record<string, number>} */
  const byStatus = {};
  for (const a of attempts) byStatus[String(a.status)] = (byStatus[String(a.status)] ?? 0) + 1;
  return {
    planned: planned.size,
    accounted: [...accounted].filter((id) => planned.has(id)).length,
    missing,
    complete: missing.length === 0,
    by_status: byStatus,
  };
}

/**
 * Curriculum transfer (SCR-16): early vs late half of the task order each
 * (condition, rep) lineage actually walked. Uses the order stored on attempts.
 * Adaptive chains contribute their first try only (pass@1).
 * @param {Array<Record<string, any>>} attempts
 */
export function curriculumTransfer(attempts) {
  /** @type {Record<string, { early: { n: number, ok: number }, late: { n: number, ok: number }, orders: Record<string, string[]> }>} */
  const byCondition = {};
  for (const a of attempts) {
    if (a.status !== "scored" || !a.score) continue;
    if (a.try_index != null && Number(a.try_index) !== 1) continue;
    const order = Array.isArray(a.task_order) ? a.task_order : null;
    if (!order?.length) continue;
    const pos = Number.isInteger(a.task_position) ? a.task_position : order.indexOf(String(a.task_id));
    if (pos < 0) continue;
    const cond = String(a.condition);
    if (!byCondition[cond]) {
      byCondition[cond] = { early: { n: 0, ok: 0 }, late: { n: 0, ok: 0 }, orders: {} };
    }
    byCondition[cond].orders[`rep${a.rep}`] = order;
    const bucket = pos < Math.ceil(order.length / 2) ? "early" : "late";
    byCondition[cond][bucket].n += 1;
    if (a.score.task_success === true) byCondition[cond][bucket].ok += 1;
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [cond, slices] of Object.entries(byCondition)) {
    const earlyRate = slices.early.n ? slices.early.ok / slices.early.n : null;
    const lateRate = slices.late.n ? slices.late.ok / slices.late.n : null;
    out[cond] = {
      split: "first half vs second half of each (condition, rep) task order as run",
      task_orders: slices.orders,
      early: { ...slices.early, rate: earlyRate },
      late: { ...slices.late, rate: lateRate },
      late_minus_early: earlyRate != null && lateRate != null ? lateRate - earlyRate : null,
    };
  }
  return out;
}

/**
 * Train pass1 vs pass2 success rates for train-freeze-eval runs.
 * @param {Array<Record<string, any>>} attempts
 */
export function trainSummary(attempts) {
  /** @type {Record<string, { n: number, ok: number, tasks: string[] }>} */
  const byPass = {};
  for (const a of attempts) {
    if (a.phase !== "train" || a.status !== "scored" || !a.score) continue;
    const p = String(a.train_pass ?? 1);
    if (!byPass[p]) byPass[p] = { n: 0, ok: 0, tasks: [] };
    byPass[p].n += 1;
    if (a.score.task_success === true) byPass[p].ok += 1;
    byPass[p].tasks.push(`${a.task_id}:${a.score.task_success ? "Y" : "N"}`);
  }
  /** @type {Record<string, any>} */
  const out = {};
  for (const [p, s] of Object.entries(byPass)) {
    out[`pass${p}`] = { n: s.n, ok: s.ok, rate: s.n ? s.ok / s.n : null, tasks: s.tasks };
  }
  const p1 = out.pass1?.rate ?? null;
  const p2 = out.pass2?.rate ?? null;
  out.pass2_minus_pass1 = p1 != null && p2 != null ? p2 - p1 : null;
  return out;
}
