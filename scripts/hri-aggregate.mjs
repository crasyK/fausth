#!/usr/bin/env node
/**
 * Aggregate frozen case-study summaries into Harness Reliability Index v0.
 *
 * Usage:
 *   node scripts/hri-aggregate.mjs [--manifest case-studies/hri/manifest.yml]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "engines/ts/package.json"));
const { parse: parseYaml } = require("yaml");

function parseArgs(argv) {
  const out = { manifest: "case-studies/hri/manifest.yml" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--manifest" && argv[i + 1]) out.manifest = argv[++i];
  }
  return out;
}

function loadJson(rel) {
  const p = join(root, rel);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

/**
 * Extract CB−PC task_success absolute delta from a standard case-study summary.
 */
function utilityFromCodingSummary(summary) {
  if (!summary) return null;
  const pd = summary.aggregates?.paired_deltas?.task_success;
  if (pd && typeof pd.absolute === "number") {
    return {
      absolute_delta: pd.absolute,
      counterbalanced: pd.counterbalanced ?? null,
      permissive_control: pd.permissive_control ?? null,
      source: "paired_deltas.task_success",
    };
  }
  const by = summary.aggregates?.by_condition;
  if (by?.counterbalanced?.task_success && by?.["permissive-control"]?.task_success) {
    const cb = by.counterbalanced.task_success_engaged ?? by.counterbalanced.task_success;
    const pc = by["permissive-control"].task_success_engaged ?? by["permissive-control"].task_success;
    return {
      absolute_delta: cb.p - pc.p,
      counterbalanced: cb,
      permissive_control: pc,
      source: "by_condition.task_success",
    };
  }
  return null;
}

/**
 * Extract attack_block_rate CB−PC from adv-live compact or full summaries.
 */
function securityFromAdvSummary(summary) {
  if (!summary) return null;

  const pd = summary.aggregates?.paired_deltas?.attack_block_rate;
  if (pd && typeof pd.absolute === "number") {
    return {
      absolute_delta: pd.absolute,
      counterbalanced: pd.counterbalanced ?? null,
      permissive_control: pd.permissive_control ?? null,
      source: "paired_deltas.attack_block_rate",
    };
  }

  // Compact adv-live-v* format: by_task_condition with blk/n
  const btc = summary.by_task_condition;
  if (btc && typeof btc === "object") {
    let cbBlk = 0;
    let cbN = 0;
    let pcBlk = 0;
    let pcN = 0;
    for (const [key, row] of Object.entries(btc)) {
      const cond = key.includes("|") ? key.split("|")[1] : "";
      const n = Number(row.n ?? 0);
      const blk = Number(row.blk ?? 0);
      if (cond === "counterbalanced") {
        cbN += n;
        cbBlk += blk;
      } else if (cond === "permissive-control") {
        pcN += n;
        pcBlk += blk;
      }
    }
    if (cbN + pcN > 0) {
      const cbP = cbN ? cbBlk / cbN : 0;
      const pcP = pcN ? pcBlk / pcN : 0;
      return {
        absolute_delta: cbP - pcP,
        counterbalanced: { p: cbP, n: cbN, successes: cbBlk },
        permissive_control: { p: pcP, n: pcN, successes: pcBlk },
        source: "by_task_condition.blk",
      };
    }
  }

  // Attempt list with attack_blocked
  if (Array.isArray(summary.attempts) && summary.attempts.length) {
    let cbBlk = 0;
    let cbN = 0;
    let pcBlk = 0;
    let pcN = 0;
    for (const a of summary.attempts) {
      if (typeof a.attack_blocked !== "boolean") continue;
      if (a.condition === "counterbalanced") {
        cbN += 1;
        if (a.attack_blocked) cbBlk += 1;
      } else if (a.condition === "permissive-control") {
        pcN += 1;
        if (a.attack_blocked) pcBlk += 1;
      }
    }
    if (cbN + pcN > 0) {
      const cbP = cbN ? cbBlk / cbN : 0;
      const pcP = pcN ? pcBlk / pcN : 0;
      return {
        absolute_delta: cbP - pcP,
        counterbalanced: { p: cbP, n: cbN, successes: cbBlk },
        permissive_control: { p: pcP, n: pcN, successes: pcBlk },
        source: "attempts.attack_blocked",
      };
    }
  }

  return null;
}

function jointFromAdvSummary(summary) {
  if (!summary?.attempts?.length) {
    return { value: null, notes: "joint utility undefined (no paired benign+block scores)" };
  }
  let cbOk = 0;
  let cbN = 0;
  for (const a of summary.attempts) {
    if (a.condition !== "counterbalanced") continue;
    if (typeof a.attack_blocked !== "boolean") continue;
    cbN += 1;
    // Pure-lure tasks: blocked attack with no unsafe side effect ⇒ utility preserved.
    const utilityOk =
      a.benign_success === true ||
      (a.attack_blocked === true && a.attack_succeeded === false);
    if (a.attack_blocked === true && utilityOk) cbOk += 1;
  }
  if (cbN === 0) {
    return { value: null, notes: "no CB attempts with attack_blocked" };
  }
  return {
    value: cbOk / cbN,
    notes: "CB rate of attack_block ∧ (benign_success or !attack_succeeded)",
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = join(root, args.manifest);
  const manifest = parseYaml(readFileSync(manifestPath, "utf8"));

  /** @type {Record<string, unknown>} */
  const tracksOut = {};
  /** @type {Array<{ track_id: string, absolute_delta: number }>} */
  const utilityComponents = [];
  /** @type {Array<{ track_id: string, absolute_delta: number }>} */
  const securityComponents = [];
  /** @type {Array<{ track_id: string, absolute_delta: number }>} */
  const policyComponents = [];
  let joint = { value: null, sources: [], notes: "" };

  for (const [key, track] of Object.entries(manifest.tracks ?? {})) {
    const summary = track.summary_path ? loadJson(track.summary_path) : null;
    const status = track.status ?? (summary ? "frozen" : "pending");

    /** @type {Record<string, unknown>} */
    const entry = {
      track_id: track.track_id ?? key,
      status,
      study_id: track.study_id ?? null,
      run_id: track.run_id ?? summary?.provenance?.run_id ?? summary?.run_id_prefix ?? null,
      summary_path: track.summary_path ?? null,
      notes: track.notes ?? null,
      metrics: {},
    };

    if (status === "pending" || !summary) {
      entry.metrics = { pending: true };
      tracksOut[key] = entry;
      continue;
    }

    if (key === "A" || track.metric_primary === "attack_block_rate") {
      const s = securityFromAdvSummary(summary);
      if (s) {
        entry.metrics.attack_block_rate_delta = s;
        securityComponents.push({ track_id: key, absolute_delta: s.absolute_delta });
      }
      joint = { ...jointFromAdvSummary(summary), sources: [track.summary_path] };
      entry.metrics.joint = joint;
    } else if (key === "T") {
      const u = utilityFromCodingSummary(summary);
      if (u) {
        entry.metrics.task_success_delta = u;
        policyComponents.push({ track_id: key, absolute_delta: u.absolute_delta });
      }
    } else if (key === "C" || key === "S" || track.metric_primary === "task_success") {
      const u = utilityFromCodingSummary(summary);
      if (u) {
        entry.metrics.task_success_delta = u;
        utilityComponents.push({ track_id: key, absolute_delta: u.absolute_delta });
      }
    }

    tracksOut[key] = entry;
  }

  const mean = (arr) =>
    arr.length === 0 ? null : arr.reduce((a, b) => a + b.absolute_delta, 0) / arr.length;

  const index = {
    schema_version: "hri-index.v0",
    generated_at: new Date().toISOString(),
    manifest_path: args.manifest,
    spec: manifest.spec ?? "docs/testing/HRI.md",
    tracks: tracksOut,
    headline: {
      HRI_utility: {
        absolute_delta: mean(utilityComponents),
        sources: utilityComponents.map((c) => c.track_id),
        components: utilityComponents,
      },
      HRI_policy: {
        absolute_delta: mean(policyComponents),
        sources: policyComponents.map((c) => c.track_id),
        components: policyComponents,
      },
      HRI_security: {
        absolute_delta: mean(securityComponents),
        sources: securityComponents.map((c) => c.track_id),
        components: securityComponents,
      },
      HRI_joint: {
        value: joint.value ?? null,
        sources: joint.sources ?? [],
        notes: joint.notes ?? "",
      },
    },
    non_claims: [
      "Not a SWE-bench or τ-bench leaderboard score",
      "Recorded adversarial rates do not enter HRI_security",
      "No single opaque scalar until Track S has ≥2 live models frozen",
    ],
  };

  const outRel = manifest.outputs?.index_path ?? "case-studies/hri/results/hri-v0.json";
  const outPath = join(root, outRel);
  mkdirSync(dirname(outPath), { recursive: true });
  const body = JSON.stringify(index, null, 2) + "\n";
  writeFileSync(outPath, body);
  const sha = createHash("sha256").update(body).digest("hex");
  writeFileSync(outPath + ".sha256", sha + "\n");
  console.log(JSON.stringify({ wrote: outRel, sha256: sha, headline: index.headline }, null, 2));
}

main();
