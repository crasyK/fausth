#!/usr/bin/env node
/**
 * Compare harness-optimization arms (one run per arm) on pass@1.
 *
 * Primary: pass@1 (first try of each (task, rep) unit) for every arm, and the
 * paired pass@1 Δ of each arm vs the baseline arm of the same version (matched
 * units across the two runs, task-clustered bootstrap CI, exact McNemar p).
 * Secondary: pass@k with its k (not comparable across arms with different k).
 * No Δ is computed when the baseline arm is missing (SCR-5).
 *
 * Read-only: summaries are never copied into case-studies/ results (CASE-13);
 * promote runs explicitly with scripts/promote-run.mjs.
 *
 * Usage: node scripts/compare-opt-arms-s.mjs [--prefixes v2,v3] [--track swe|tau]
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collapseToUnits, pairedComparison } from "./case-study-score.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const ARMS = ["baseline", "budget", "mutable", "optimize"];
export const COND = {
  baseline: "counterbalanced",
  budget: "cb-budget",
  mutable: "cb-mutable",
  optimize: "cb-optimize",
};
const TRACK_DIRS = { swe: "swe-bench", tau: "tau-bench" };

/**
 * @param {string} track swe|tau
 * @param {string} prefix version tag
 * @param {string} arm
 * @param {string} [base] repo root
 */
export function loadArmSummary(track, prefix, arm, base = root) {
  const study = TRACK_DIRS[track] ?? track;
  const name = `hri-${track}-opt-arms-${prefix}-${arm}`;
  for (const p of [
    join(base, "case-studies", study, "results", `${name}.summary.json`),
    join(base, "live/reports/case-studies", study, name, "summary.json"),
  ]) {
    if (existsSync(p)) return { summary: JSON.parse(readFileSync(p, "utf8")), path: p };
  }
  return null;
}

/** @param {number | null | undefined} p */
const pct = (p) => (p == null ? "—" : `${(p * 100).toFixed(1)}%`);
/** @param {number | null | undefined} d */
const pp = (d) => (d == null ? "—" : `${d >= 0 ? "+" : ""}${(d * 100).toFixed(1)}`);

/**
 * pass@1 / pass@k for one arm's units.
 * @param {Array<Record<string, any>>} units
 * @param {string} condition
 */
export function armRates(units, condition) {
  const rows = units.filter((u) => u.condition === condition);
  const scored = rows.filter((u) => u.status === "scored" && u.score);
  const ok = scored.filter((u) => u.score.task_success === true).length;
  const kRows = rows.filter((u) => typeof u.pass_at_k?.success === "boolean");
  const ks = [...new Set(kRows.map((u) => u.pass_at_k.k))];
  return {
    units: rows.length,
    pass_at_1: { p: scored.length ? ok / scored.length : null, successes: ok, n: scored.length },
    pass_at_k:
      ks.length === 1
        ? {
            k: ks[0],
            p: kRows.length ? kRows.filter((u) => u.pass_at_k.success).length / kRows.length : null,
            n: kRows.length,
          }
        : { k: null, mixed_k: ks.sort(), p: null, n: kRows.length },
  };
}

/**
 * Rows for one version: every arm's pass@1, paired Δ vs baseline, pass@k.
 * @param {Record<string, { summary: Record<string, any>, path: string } | null>} loaded
 */
export function compareVersion(loaded) {
  const baseline = loaded.baseline;
  const baselineUnits = baseline ? collapseToUnits(baseline.summary.attempts ?? []) : [];
  /** @type {Array<Record<string, any>>} */
  const rows = [];
  for (const arm of ARMS) {
    const entry = loaded[arm];
    if (!entry) {
      rows.push({ arm, missing: true });
      continue;
    }
    const cond = COND[arm];
    const units = collapseToUnits(entry.summary.attempts ?? []);
    const rates = armRates(units, cond);
    let delta;
    if (arm === "baseline") delta = { status: "baseline" };
    else if (!baseline) delta = { status: "missing_arm", note: "baseline arm absent — no Δ" };
    else delta = pairedComparison([...baselineUnits, ...units], cond, COND.baseline, "task_success");
    rows.push({
      arm,
      condition: cond,
      source: relative(root, entry.path),
      invariants_ok: entry.summary.invariants?.ok ?? null,
      ...rates,
      delta,
    });
  }
  return rows;
}

/** @param {string} version @param {Array<Record<string, any>>} rows */
export function formatRows(version, rows) {
  const out = [];
  for (const r of rows) {
    if (r.missing) {
      out.push(`${version}\t${r.arm.padEnd(9)}\t(no summary)`);
      continue;
    }
    const d = r.delta;
    const dCell =
      d.status === "baseline"
        ? "(baseline)"
        : d.status === "ok"
          ? `${pp(d.absolute)} [${pp(d.ci95?.low)}, ${pp(d.ci95?.high)}] n=${d.n_matched} p=${d.mcnemar.p_exact.toFixed(3)}`
          : `n/a (${d.status})`;
    const k = r.pass_at_k.k == null ? "— (mixed k)" : `${pct(r.pass_at_k.p)} (k=${r.pass_at_k.k})`;
    const inv = r.invariants_ok === false ? "\tINVARIANTS FAILED" : "";
    out.push(
      `${version}\t${r.arm.padEnd(9)}\t${pct(r.pass_at_1.p)} (${r.pass_at_1.successes}/${r.pass_at_1.n})\t${dCell}\t${k}${inv}`,
    );
  }
  return out.join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  const get = (flag, dflt) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  const prefixes = get("--prefixes", "v2,v3").split(",").map((s) => s.trim()).filter(Boolean);
  const track = get("--track", "swe");
  console.log(`Track ${track.toUpperCase()} opt-arms — pass@1 is primary; Δ = paired pass@1 vs the baseline arm of the same version`);
  console.log("pass@k (secondary) is only comparable between arms with the same k.\n");
  console.log("version\tarm      \tpass@1\tΔ pp vs baseline [95% CI] matched-n McNemar-p\tpass@k (k)");
  for (const prefix of prefixes) {
    const loaded = Object.fromEntries(ARMS.map((arm) => [arm, loadArmSummary(track, prefix, arm)]));
    console.log(formatRows(prefix, compareVersion(loaded)));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
