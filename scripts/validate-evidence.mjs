#!/usr/bin/env node
/**
 * Minimal evidence-pack validator (HarnessC-inspired wall, v0.1).
 * Usage: node scripts/validate-evidence.mjs [resultsDir ...]
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), "../engines/ts/package.json"));
const { parse: parseYaml } = require("yaml");

const DEFAULT_DIRS = [
  "case-studies/swe-bench/results",
];

function loadClaim(dir) {
  const p = join(dir, "claim.yml");
  if (!existsSync(p)) return { path: p, error: "missing claim.yml" };
  try {
    const doc = parseYaml(readFileSync(p, "utf8"));
    return { path: p, doc };
  } catch (e) {
    return { path: p, error: `claim.yml parse error: ${e}` };
  }
}

function validateClaim(dir, { path, doc, error }) {
  const issues = [];
  if (error) {
    issues.push(error);
    return issues;
  }
  const c = doc;
  for (const key of [
    "study_id",
    "claimed",
    "not_claimed",
    "population",
    "evaluation_matrix",
    "hashes",
    "independence",
    "outcome",
    "recorded_vs_live",
  ]) {
    if (c[key] === undefined || c[key] === null) issues.push(`claim.yml missing required field: ${key}`);
  }
  if (Array.isArray(c.claimed) && c.claimed.length === 0) issues.push("claimed must be non-empty");
  if (Array.isArray(c.not_claimed) && c.not_claimed.length === 0) {
    issues.push("not_claimed must be non-empty (explicit exclusions required)");
  }
  if (c.hashes && typeof c.hashes === "object" && Object.keys(c.hashes).length === 0) {
    issues.push("hashes must contain at least one digest");
  }
  const outcome = c.outcome;
  const residualsPath = join(dir, "residuals.json");
  if ((outcome === "negative" || outcome === "inconclusive") && !existsSync(residualsPath)) {
    issues.push("residuals.json required for negative/inconclusive outcomes");
  }
  const claimText = [
    ...(c.claimed ?? []),
    ...(c.independence ?? []),
  ]
    .join(" ")
    .toLowerCase();
  if (claimText.includes("mutable") && !claimText.includes("holdout")) {
    issues.push("mutation-related claim should reference holdout splits");
  }
  if (
    claimText.includes("recorded") &&
    claimText.includes("live") &&
    !String(c.recorded_vs_live ?? "").length
  ) {
    issues.push("recorded_vs_live must explain recorded vs live separation");
  }
  return issues;
}

function validateDir(dir) {
  const abs = resolve(dir);
  const name = abs.split("/").slice(-2).join("/");
  if (!existsSync(abs)) return { name: abs, skipped: true, issues: [] };
  const claim = loadClaim(abs);
  const issues = validateClaim(abs, claim);
  const provenance = join(abs, "PROVENANCE.md");
  if (!existsSync(provenance) && existsSync(join(abs, "claim.yml"))) {
    issues.push("PROVENANCE.md recommended when claim.yml present");
  }
  return { name, issues, ok: issues.length === 0 };
}

const dirs = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_DIRS;
let failed = 0;
for (const d of dirs) {
  const r = validateDir(d);
  if (r.skipped) {
    console.log(`SKIP ${r.name} (not found)`);
    continue;
  }
  if (r.ok) console.log(`OK   ${r.name}`);
  else {
    failed++;
    console.log(`FAIL ${r.name}`);
    for (const i of r.issues) console.log(`     - ${i}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
