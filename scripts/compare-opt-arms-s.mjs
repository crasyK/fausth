#!/usr/bin/env node
/**
 * Copy live v3 SWE summaries to results/ and print v2 vs v3 any-of comparison.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const liveSwe = join(root, "live/reports/case-studies/swe-bench");
const results = join(root, "case-studies/swe-bench/results");

const ARMS = ["baseline", "budget", "mutable", "optimize"];
const COND = {
  baseline: "counterbalanced",
  budget: "cb-budget",
  mutable: "cb-mutable",
  optimize: "cb-optimize",
};

function loadSummary(prefix, arm) {
  const frozen = join(results, `hri-swe-opt-arms-${prefix}-${arm}.summary.json`);
  if (existsSync(frozen)) return JSON.parse(readFileSync(frozen, "utf8"));
  const live = join(liveSwe, `hri-swe-opt-arms-${prefix}-${arm}`, "summary.json");
  if (existsSync(live)) return JSON.parse(readFileSync(live, "utf8"));
  return null;
}

mkdirSync(results, { recursive: true });
for (const arm of ARMS) {
  const live = join(liveSwe, `hri-swe-opt-arms-v3-${arm}`, "summary.json");
  const dest = join(results, `hri-swe-opt-arms-v3-${arm}.summary.json`);
  if (existsSync(live)) {
    copyFileSync(live, dest);
    console.error(`[copied] ${dest}`);
  }
}

console.log("Track S opt-arms — task_success_any_of (v2 vs v3)\n");
console.log("arm\t\tv2 any-of\tv3 any-of\tΔ pp\tv3 scored");
for (const arm of ARMS) {
  const cond = COND[arm];
  const v2 = loadSummary("v2", arm);
  const v3 = loadSummary("v3", arm);
  const v2ao = v2?.adaptive_arms?.[cond]?.task_success_any_of;
  const v3ao = v3?.adaptive_arms?.[cond]?.task_success_any_of;
  const v2p = v2ao ? `${(v2ao.p * 100).toFixed(1)}% (${v2ao.successes}/${v2ao.n})` : "—";
  const v3p = v3ao ? `${(v3ao.p * 100).toFixed(1)}% (${v3ao.successes}/${v3ao.n})` : "—";
  const delta =
    v2ao && v3ao ? `${((v3ao.p - v2ao.p) * 100).toFixed(1)}` : "—";
  const scored = v3?.aggregates?.n_scored ?? "—";
  console.log(`${arm.padEnd(10)}\t${v2p}\t${v3p}\t${delta}\t${scored}`);
}
