/**
 * Tracking helpers for S/T harness-optimization parallel arms.
 * Try chains, never-reset lineage audit, optimize digests, attribution.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collapseToUnits, pairedComparison } from "./case-study-score.mjs";

export const ADAPTIVE_CONDITIONS = new Set(["cb-mutable", "cb-optimize"]);
export const OPTIMIZE_CONDITIONS = new Set(["cb-optimize"]);
export const BUDGET_CONDITIONS = new Set(["cb-budget"]);
export const DEFAULT_MAX_TASK_TRIES = 5;

/** @param {string} condition */
export function isAdaptiveCondition(condition) {
  return ADAPTIVE_CONDITIONS.has(String(condition));
}

/** @param {string} condition */
export function isOptimizeCondition(condition) {
  return OPTIMIZE_CONDITIONS.has(String(condition));
}

/** @param {string} condition */
export function usesNeverResetLineage(condition) {
  return isAdaptiveCondition(condition);
}

/**
 * Identity of one analysis unit: (task, condition, deployment, model, rep[, phase/pass]).
 * Tries of an adaptive arm share it; train passes / eval slots do not.
 * @param {Record<string, unknown>} item
 */
export function taskChainId(item) {
  const parts = [
    item.task_id,
    item.condition,
    item.deployment_id,
    String(item.model_id ?? "").replace(/[^a-zA-Z0-9._-]+/g, "-"),
    `rep${item.rep}`,
  ];
  if (item.phase === "train") parts.push(`train_pass${item.train_pass ?? 1}`);
  else if (item.phase === "eval") parts.push("eval");
  return parts.join("__");
}

/**
 * @param {Record<string, unknown>} item
 */
export function attemptIdWithTry(item) {
  const parts = [
    item.task_id,
    item.condition,
    item.deployment_id,
    String(item.model_id ?? "").replace(/[^a-zA-Z0-9._-]+/g, "-"),
    `rep${item.rep}`,
  ];
  if (item.phase === "train") parts.push(`train_pass${item.train_pass ?? 1}`);
  else if (item.phase === "eval") parts.push("eval");
  if (item.try_index != null) parts.push(`try${item.try_index}`);
  return parts.join("__");
}

/** @param {string} filePath */
export function sha256File(filePath) {
  if (!existsSync(filePath)) return null;
  const h = createHash("sha256");
  h.update(readFileSync(filePath));
  return h.digest("hex");
}

/** @param {string} harnessDir */
export function harnessIrHash(harnessDir) {
  const agentJson = join(harnessDir, "agent.json");
  if (existsSync(agentJson)) return sha256File(agentJson);
  const agentYml = join(harnessDir, "agent.yml");
  return sha256File(agentYml);
}

/**
 * Security surface = tool ids + permissions + sequences (skills/descriptions excluded).
 * @param {string} harnessDir
 */
export function securitySurfaceHash(harnessDir) {
  const agentJson = join(harnessDir, "agent.json");
  const agentYml = join(harnessDir, "agent.yml");
  let raw = null;
  if (existsSync(agentJson)) {
    raw = JSON.parse(readFileSync(agentJson, "utf8"));
  } else if (existsSync(agentYml)) {
    // YAML not parsed here — hash permissions-ish lines only as fallback fingerprint of file
    return sha256File(agentYml);
  } else {
    return null;
  }
  const tools = (raw.tools ?? []).map((t) => t.id).sort();
  const surface = {
    tools,
    permissions: raw.permissions ?? null,
    sequences: raw.counterbalance?.sequences ?? null,
    completion: raw.counterbalance?.completion ?? null,
    mutable: raw.mutable ?? null,
  };
  const h = createHash("sha256");
  h.update(JSON.stringify(surface));
  return h.digest("hex");
}

/** τ-bench retail tool catalog (from case-studies/tau-bench/world/tau.mjs). */
export const TAU_API_REFERENCE =
  "Valid tools: find_user_id_by_name_zip, find_user_id_by_email, get_user_details, " +
  "get_order_details, get_product_details, list_all_product_types, cancel_pending_order, " +
  "return_delivered_order_items, exchange_delivered_order_items, modify_pending_order_address, " +
  "modify_user_address, transfer_to_human_agents, think, calculate. " +
  "Common hallucinations: get_user_id, search_user, get_user_by_name_and_zip.";

/**
 * Compact failure digest for the optimizer harness.
 * @param {{ eventsText: string, report: Record<string, unknown>, grade?: Record<string, unknown>, score?: Record<string, unknown>, hints?: string }} opts
 */
export function buildOptimizeDigest(opts) {
  const { eventsText, report, grade, score, hints } = opts;
  const lines = eventsText.split(/\r?\n/).filter(Boolean);
  /** @type {Record<string, number>} */
  const toolHist = {};
  /** @type {Record<string, number>} */
  const denyHist = {};
  /** @type {Set<string>} */
  const unknownTools = new Set();
  const unknownRe = /Error:\s*unknown tool\s+(\S+)/gi;
  const tail = [];
  for (const line of lines) {
    unknownRe.lastIndex = 0;
    let m;
    while ((m = unknownRe.exec(line)) !== null) {
      unknownTools.add(m[1].replace(/["',\]]+$/, ""));
    }
    try {
      const e = JSON.parse(line);
      if (e.tool) toolHist[e.tool] = (toolHist[e.tool] ?? 0) + 1;
      if (e.verdict === "deny" || e.stage === "authorize" && e.reason) {
        const k = String(e.reason ?? e.failure?.code ?? "deny");
        denyHist[k] = (denyHist[k] ?? 0) + 1;
      }
      if (e.stage === "execute" || e.stage === "authorize" || e.stage === "record") {
        tail.push(line);
      }
    } catch {
      /* skip */
    }
  }
  const last = tail.slice(-40);
  /** @type {string[]} */
  const parts = [
    "# Optimize digest",
    "",
    "## Outcome",
    `- pipeline_blocked: ${report.pipeline_blocked ?? "null"}`,
    `- completion_reached: ${report.completion_reached ?? false}`,
    `- ground_truth_pass: ${grade?.ground_truth_pass ?? report.ground_truth_pass ?? false}`,
    `- task_success: ${score?.task_success ?? false}`,
    `- discovery_failure: ${score?.discovery_failure ?? false}`,
    `- false_completion: ${score?.false_completion ?? false}`,
    "",
  ];
  if (hints) {
    parts.push("## Track hints", hints, "");
  }
  if (unknownTools.size > 0) {
    parts.push(
      "## tau stdout errors",
      ...[...unknownTools].map((t) => `- Error: unknown tool ${t}`),
      "",
    );
  }
  parts.push(
    "## Tool histogram",
    "```json",
    JSON.stringify(toolHist, null, 2),
    "```",
    "",
    "## Deny / reason histogram",
    "```json",
    JSON.stringify(denyHist, null, 2),
    "```",
    "",
    "## Last events",
    "```jsonl",
    ...last,
    "```",
    "",
    "## Instructions",
    "Propose at most one set_tool_description skill improvement that would have helped,",
    "or decline with reason skills_already_adequate / insufficient_evidence / would_overfit_task.",
    "Do not change permissions, sequences, or tool schemas.",
  );
  return parts.join("\n");
}

/**
 * Append lineage history event.
 * @param {string} historyPath
 * @param {Record<string, unknown>} event
 */
export function appendLineageHistory(historyPath, event) {
  mkdirSync(join(historyPath, ".."), { recursive: true });
  appendFileSync(
    historyPath,
    JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n",
  );
}

/**
 * Never-reset / try-chain invariants (SCR-7, SCR-8).
 *
 * Only rows that are tries of an adaptive chain (`try_index != null`) are
 * checked for try sequencing; single-try rows (`try_index: null`) are complete
 * units on their own. A chain must hold tries 1..n without gaps; tries after a
 * success must be accounted as `skipped_after_success` (never scored).
 * @param {Array<Record<string, unknown>>} attempts
 */
export function checkOptInvariants(attempts) {
  /** @type {string[]} */
  const violations = [];
  /** @type {Map<string, Array<Record<string, any>>>} */
  const byChain = new Map();
  for (const a of attempts) {
    if (a.stock_reload === true) {
      violations.push(`${a.attempt_id ?? a.task_chain_id ?? "?"}: stock_reload`);
    }
    if (a.security_intact === false) {
      violations.push(`${a.attempt_id ?? a.task_chain_id ?? "?"}: security_surface drifted`);
    }
    if (a.try_index == null) continue;
    if (!a.task_chain_id) {
      violations.push(`${a.attempt_id ?? "?"}: try ${a.try_index} without task_chain_id`);
      continue;
    }
    const k = String(a.task_chain_id);
    if (!byChain.has(k)) byChain.set(k, []);
    byChain.get(k).push(a);
  }
  for (const [chainId, rows] of byChain) {
    const tries = [...rows].sort((x, y) => Number(x.try_index) - Number(y.try_index));
    let succeededAt = null;
    for (let i = 0; i < tries.length; i++) {
      const t = tries[i];
      const expected = i + 1;
      if (Number(t.try_index) !== expected) {
        violations.push(`${chainId}: try_index gap (expected ${expected}, got ${t.try_index})`);
      }
      if (i > 0 && !t.parent_attempt_id) {
        violations.push(`${chainId}: try ${t.try_index} missing parent_attempt_id`);
      }
      if (succeededAt != null && t.status !== "skipped_after_success") {
        violations.push(
          `${chainId}: try ${t.try_index} ran after success on try ${succeededAt}`,
        );
      }
      if (t.status === "skipped_after_success" && succeededAt == null) {
        violations.push(`${chainId}: try ${t.try_index} skipped without a prior success`);
      }
      if (succeededAt == null && t.status === "scored" && t.score?.task_success === true) {
        succeededAt = Number(t.try_index);
      }
    }
    const headline = tries.find((t) => t.outcome_role === "headline");
    if (headline?.headline_success === true) {
      const anyPass = tries.some((t) => t.status === "scored" && t.score?.task_success === true);
      if (!anyPass) {
        violations.push(`${chainId}: headline_success without graded pass`);
      }
    }
  }
  return {
    ok: violations.length === 0,
    never_reset_violations: violations.length,
    violations,
  };
}

/**
 * Per-arm adaptive metrics (SCR-5). Primary: pass@1 = success on try 1 of each
 * (task, rep) chain — directly comparable with single-try arms. Secondary:
 * pass@k with k = planned tries (NOT comparable across arms with different k).
 * @param {Array<Record<string, unknown>>} attempts
 * @param {string} condition
 */
export function adaptiveArmStats(attempts, condition) {
  const rows = attempts.filter((a) => a.condition === condition);
  /** @type {Map<string, Array<Record<string, any>>>} */
  const byChain = new Map();
  for (const a of rows) {
    const k = String(a.task_chain_id ?? a.attempt_id);
    if (!byChain.has(k)) byChain.set(k, []);
    byChain.get(k).push(a);
  }
  let n1 = 0;
  let firstTrySuccess = 0;
  let nk = 0;
  let anyOfSuccess = 0;
  /** @type {Set<number>} */
  const ks = new Set();
  /** @type {number[]} */
  const triesToSuccess = [];
  /** @type {number[]} */
  const triesRun = [];
  /** @type {Record<string, number>} */
  const triesHistogram = {};
  let patch = 0;
  let decline = 0;
  let selectionOk = 0;
  let selectionN = 0;
  let optimizeHelped = 0;
  let securityIntact = 0;
  let securityN = 0;
  let skipped = 0;

  for (const [, chain] of byChain) {
    const ordered = [...chain].sort(
      (a, b) => Number(a.try_index ?? 1) - Number(b.try_index ?? 1),
    );
    const k = Math.max(
      1,
      ...ordered.map((a) => Number(a.max_task_tries ?? 1)).filter(Number.isFinite),
    );
    ks.add(k);
    const first = ordered.find((a) => Number(a.try_index ?? 1) === 1);
    if (first?.status === "scored" && first.score) {
      n1 += 1;
      if (first.score.task_success === true) firstTrySuccess += 1;
    }
    const scored = ordered.filter((a) => a.status === "scored" && a.score);
    skipped += ordered.filter((a) => a.status === "skipped_after_success").length;
    triesRun.push(ordered.filter((a) => a.status !== "skipped_after_success").length);
    if (scored.length) {
      nk += 1;
      const win = scored.find((a) => a.score.task_success === true);
      if (win) {
        anyOfSuccess += 1;
        const t = Number(win.try_index ?? 1);
        triesToSuccess.push(t);
        triesHistogram[String(t)] = (triesHistogram[String(t)] ?? 0) + 1;
        const priorFail = scored.some((a) => Number(a.try_index ?? 1) < t);
        const hadPatch = ordered.some((a) => a.selection_ok === true);
        if (priorFail && hadPatch && condition === "cb-optimize") optimizeHelped += 1;
      }
    }
    for (const a of ordered) {
      if (a.disposition === "patch") patch += 1;
      if (a.disposition === "decline" || a.disposition === "optimize_decline") decline += 1;
      if (a.selection_ok != null) {
        selectionN += 1;
        if (a.selection_ok) selectionOk += 1;
      }
      if (a.security_intact != null) {
        securityN += 1;
        if (a.security_intact) securityIntact += 1;
      }
    }
  }

  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const kList = [...ks].sort((a, b) => a - b);
  const passAt1 = { p: n1 ? firstTrySuccess / n1 : null, successes: firstTrySuccess, n: n1 };
  const passAtK = {
    k: kList.length === 1 ? kList[0] : null,
    mixed_k: kList.length > 1 ? kList : undefined,
    p: nk ? anyOfSuccess / nk : null,
    successes: anyOfSuccess,
    n: nk,
    note: "secondary: success on any of k tries; not comparable across arms with different k",
  };
  return {
    n_task_chains: byChain.size,
    pass_at_1: passAt1,
    task_success_first_try: passAt1,
    pass_at_k: passAtK,
    /** @deprecated secondary pass@k under its legacy name; never compare with pass@1. */
    task_success_any_of: passAtK,
    tries_histogram: triesHistogram,
    tries_skipped_after_success: skipped,
    mean_tries_to_success: mean(triesToSuccess),
    mean_tries_run: mean(triesRun),
    patch_rate: patch + decline ? patch / (patch + decline) : null,
    decline_rate: patch + decline ? decline / (patch + decline) : null,
    selection_ok_rate: selectionN ? selectionOk / selectionN : null,
    security_intact_rate: securityN ? securityIntact / securityN : null,
    optimize_helped: optimizeHelped,
  };
}

/** @param {number | null | undefined} p */
function pct(p) {
  return p == null ? "—" : `${(p * 100).toFixed(1)}%`;
}

/** @param {number | null | undefined} d */
function pp(d) {
  return d == null ? "—" : `${d >= 0 ? "+" : ""}${(d * 100).toFixed(1)}`;
}

/**
 * Markdown banner for failed invariants (CASE-16): results must not be read silently.
 * @param {{ ok: boolean, violations: string[] }} invariants
 */
export function invariantsBanner(invariants) {
  if (!invariants || invariants.ok) return [];
  return [
    "> **INVARIANTS FAILED** — this run violates try-chain / never-reset invariants;",
    `> its numbers are not trustworthy until the ${invariants.violations.length} violation(s) below are explained.`,
    "",
  ];
}

/**
 * Attribution table (SCR-5): pass@1 for every arm is the primary metric and the
 * only basis for Δ; pass@k is a labelled secondary column. Δ is refused when
 * the comparator (baseline) arm is absent.
 * @param {string} outPath
 * @param {{ track: string, attempts: Array<Record<string, unknown>>, baselineCondition?: string, invariants: ReturnType<typeof checkOptInvariants> }} opts
 */
export function writeAttributionMd(outPath, opts) {
  writeFileSync(outPath, attributionMarkdown(opts));
}

/**
 * @param {{ track: string, attempts: Array<Record<string, unknown>>, baselineCondition?: string, invariants: ReturnType<typeof checkOptInvariants> }} opts
 */
export function attributionMarkdown(opts) {
  const { track, attempts, baselineCondition = "counterbalanced", invariants } = opts;
  const units = collapseToUnits(attempts);
  const conditions = [...new Set(attempts.map((a) => String(a.condition)))].sort();
  const baselinePresent = units.some(
    (u) => u.condition === baselineCondition && u.status === "scored",
  );
  const lines = [
    `# Attribution — Track ${track}`,
    "",
    ...invariantsBanner(invariants),
    `Baseline condition: \`${baselineCondition}\`${baselinePresent ? "" : " — **absent from this run (no Δ computed)**"}`,
    "",
    "Primary metric: **pass@1** (success on the first try of each (task, rep) unit) for every arm.",
    "Δ is a paired pass@1 difference over matched units. pass@k (any of k tries) is secondary and",
    "only comparable between arms with the same k.",
    "",
    "| Arm | Units | pass@1 | Δ pass@1 vs baseline (pp) | matched n | 95% CI (pp) | McNemar p | pass@k (k) | Mean tries to success |",
    "|-----|-------|--------|---------------------------|-----------|-------------|-----------|------------|-----------------------|",
  ];
  /** @type {Record<string, ReturnType<typeof adaptiveArmStats>>} */
  const statsByArm = {};
  for (const cond of conditions) {
    statsByArm[cond] = adaptiveArmStats(attempts, cond);
  }
  const ks = new Set(
    Object.values(statsByArm)
      .map((s) => s.pass_at_k.k)
      .filter((k) => k != null),
  );
  for (const cond of conditions) {
    const stats = statsByArm[cond];
    let deltaCell = "—";
    let nCell = "—";
    let ciCell = "—";
    let pCell = "—";
    if (cond === baselineCondition) {
      deltaCell = "(baseline)";
    } else if (!baselinePresent) {
      deltaCell = "n/a (baseline arm absent)";
    } else {
      const d = pairedComparison(units, cond, baselineCondition, "task_success");
      if (d.status === "ok") {
        deltaCell = pp(d.absolute);
        nCell = String(d.n_matched);
        ciCell = d.ci95 ? `[${pp(d.ci95.low)}, ${pp(d.ci95.high)}]` : "—";
        pCell = d.mcnemar ? d.mcnemar.p_exact.toFixed(3) : "—";
      } else {
        deltaCell = `n/a (${d.status})`;
      }
    }
    const k = stats.pass_at_k.k;
    const passK = k == null ? "— (mixed k)" : `${pct(stats.pass_at_k.p)} (k=${k})`;
    lines.push(
      `| ${cond} | ${stats.n_task_chains} | ${pct(stats.pass_at_1.p)} (${stats.pass_at_1.successes}/${stats.pass_at_1.n}) | ${deltaCell} | ${nCell} | ${ciCell} | ${pCell} | ${passK} | ${stats.mean_tries_to_success == null ? "—" : stats.mean_tries_to_success.toFixed(2)} |`,
    );
  }
  if (ks.size > 1) {
    lines.push("");
    lines.push(
      `_pass@k columns use different k across arms (${[...ks].sort().join(", ")}); do not compare them._`,
    );
  }
  lines.push("");
  lines.push("## Invariants");
  lines.push("");
  lines.push(`- never_reset_violations: **${invariants.never_reset_violations}**`);
  lines.push(`- ok: ${invariants.ok}`);
  if (invariants.violations.length) {
    lines.push("");
    lines.push("### Violations");
    for (const v of invariants.violations) lines.push(`- ${v}`);
  }
  lines.push("");
  lines.push("See `ledger.json`, `lineage/history.jsonl`, and per-attempt `optimize/` / `phases/` artifacts.");
  lines.push("");
  return lines.join("\n");
}
