/**
 * Tracking helpers for S/T harness-optimization parallel arms.
 * Try chains, never-reset lineage audit, optimize digests, attribution.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
 * @param {Record<string, unknown>} item
 * @param {number} [tryIndex]
 */
export function taskChainId(item, tryIndex) {
  return [
    item.task_id,
    item.condition,
    item.deployment_id,
    String(item.model_id ?? "").replace(/[^a-zA-Z0-9._-]+/g, "-"),
    `rep${item.rep}`,
  ].join("__");
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
 * @param {Array<Record<string, unknown>>} attempts
 */
export function checkOptInvariants(attempts) {
  /** @type {string[]} */
  const violations = [];
  /** @type {Map<string, Array<Record<string, unknown>>>} */
  const byChain = new Map();
  for (const a of attempts) {
    if (!a.task_chain_id) continue;
    const k = String(a.task_chain_id);
    if (!byChain.has(k)) byChain.set(k, []);
    byChain.get(k).push(a);
  }
  for (const [chainId, rows] of byChain) {
    const tries = [...rows].sort(
      (x, y) => Number(x.try_index ?? 0) - Number(y.try_index ?? 0),
    );
    for (let i = 0; i < tries.length; i++) {
      const t = tries[i];
      const expected = i + 1;
      if (Number(t.try_index) !== expected) {
        violations.push(`${chainId}: try_index gap (expected ${expected}, got ${t.try_index})`);
      }
      if (i > 0 && !t.parent_attempt_id) {
        violations.push(`${chainId}: try ${t.try_index} missing parent_attempt_id`);
      }
      if (t.stock_reload === true) {
        violations.push(`${chainId}: stock_reload on try ${t.try_index}`);
      }
      if (t.security_intact === false) {
        violations.push(`${chainId}: security_surface drifted on try ${t.try_index}`);
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
 * Aggregate adaptive-arm metrics for summary.
 * @param {Array<Record<string, unknown>>} attempts
 * @param {string} condition
 */
export function adaptiveArmStats(attempts, condition) {
  const rows = attempts.filter(
    (a) => a.condition === condition && a.status === "scored",
  );
  /** @type {Map<string, Array<Record<string, unknown>>>} */
  const byChain = new Map();
  for (const a of rows) {
    const k = String(a.task_chain_id ?? a.attempt_id);
    if (!byChain.has(k)) byChain.set(k, []);
    byChain.get(k).push(a);
  }
  let anyOfSuccess = 0;
  let firstTrySuccess = 0;
  /** @type {number[]} */
  const triesToSuccess = [];
  /** @type {number[]} */
  const triesAll = [];
  /** @type {Record<string, number>} */
  const triesHistogram = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  let patch = 0;
  let decline = 0;
  let selectionOk = 0;
  let selectionN = 0;
  let optimizeHelped = 0;
  let securityIntact = 0;
  let securityN = 0;

  for (const [, chain] of byChain) {
    const ordered = [...chain].sort(
      (a, b) => Number(a.try_index ?? 1) - Number(b.try_index ?? 1),
    );
    const nTries = ordered.length;
    triesAll.push(nTries);
    const successIdx = ordered.findIndex((a) => a.score?.task_success === true);
    if (successIdx >= 0) {
      anyOfSuccess += 1;
      triesToSuccess.push(successIdx + 1);
      const bucket = String(Math.min(5, successIdx + 1));
      triesHistogram[bucket] = (triesHistogram[bucket] ?? 0) + 1;
      if (successIdx === 0) firstTrySuccess += 1;
      const priorFail = ordered.slice(0, successIdx).some((a) => a.score?.task_success !== true);
      const hadPatch = ordered.some((a) => a.selection_ok === true);
      if (priorFail && hadPatch && condition === "cb-optimize") optimizeHelped += 1;
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

  const nChains = byChain.size;
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    n_task_chains: nChains,
    task_success_any_of: nChains
      ? { p: anyOfSuccess / nChains, successes: anyOfSuccess, n: nChains }
      : { p: 0, successes: 0, n: 0 },
    task_success_first_try: nChains
      ? { p: firstTrySuccess / nChains, successes: firstTrySuccess, n: nChains }
      : { p: 0, successes: 0, n: 0 },
    tries_histogram: triesHistogram,
    mean_tries_to_success: mean(triesToSuccess),
    mean_tries_all: mean(triesAll),
    patch_rate: patch + decline ? patch / (patch + decline) : null,
    decline_rate: patch + decline ? decline / (patch + decline) : null,
    selection_ok_rate: selectionN ? selectionOk / selectionN : null,
    security_intact_rate: securityN ? securityIntact / securityN : null,
    optimize_helped: optimizeHelped,
  };
}

/**
 * @param {string} outPath
 * @param {{ track: string, attempts: Array<Record<string, unknown>>, baselineCondition?: string, invariants: ReturnType<typeof checkOptInvariants> }} opts
 */
export function writeAttributionMd(outPath, opts) {
  const { track, attempts, baselineCondition = "counterbalanced", invariants } = opts;
  const conditions = [...new Set(attempts.map((a) => String(a.condition)))].sort();
  const lines = [
    `# Attribution — Track ${track}`,
    "",
    `Baseline condition: \`${baselineCondition}\``,
    "",
    "| Arm | Any-of success | First-try | Mean tries (success) | Δ vs baseline (pp) |",
    "|-----|----------------|-----------|----------------------|--------------------|",
  ];
  const baselineStats = adaptiveArmStats(
    attempts.filter((a) => a.outcome_role === "headline" || a.try_index == null || a.try_index === 1),
    baselineCondition,
  );
  // For baseline (static), use scored attempts directly
  const baselineRows = attempts.filter(
    (a) => a.condition === baselineCondition && a.status === "scored",
  );
  const baselineP =
    baselineRows.length === 0
      ? 0
      : baselineRows.filter((a) => a.score?.task_success === true).length / baselineRows.length;

  for (const cond of conditions) {
    const stats = isAdaptiveCondition(cond)
      ? adaptiveArmStats(attempts, cond)
      : null;
    let p;
    let first;
    let meanTries;
    if (stats) {
      p = stats.task_success_any_of.p;
      first = stats.task_success_first_try.p;
      meanTries = stats.mean_tries_to_success;
    } else {
      const rows = attempts.filter((a) => a.condition === cond && a.status === "scored");
      p = rows.length ? rows.filter((a) => a.score?.task_success).length / rows.length : 0;
      first = p;
      meanTries = 1;
    }
    const delta = ((p - baselineP) * 100).toFixed(1);
    lines.push(
      `| ${cond} | ${(p * 100).toFixed(1)}% | ${(first * 100).toFixed(1)}% | ${meanTries == null ? "—" : meanTries.toFixed(2)} | ${delta} |`,
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
  writeFileSync(outPath, lines.join("\n"));
}
