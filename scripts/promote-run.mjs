#!/usr/bin/env node
/**
 * Promote a finished run into its case study's results/ (CASE-13).
 *
 * The runner only ever writes to live/reports/... ; this is the single, explicit
 * way a summary enters case-studies/<study>/results/. It copies summary.json
 * byte-for-byte (checksum verified) and writes a promotion record with the run's
 * provenance next to it.
 *
 * Refuses (unless overridden explicitly, which is recorded):
 *   - recorded runs (never evidence)                    — no override
 *   - non-evidence live runs (dirty tree, smoke, drift) — --allow-non-evidence
 *   - failed invariants or an incomplete plan           — --allow-failed-checks
 *   - overwriting an existing results file              — --force
 *
 * Usage:
 *   node scripts/promote-run.mjs --run <raw-run-dir | run-id> [--manifest <path>] [--as <name>]
 *        [--allow-non-evidence] [--allow-failed-checks] [--force]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "engines/ts/package.json"));
const { parse: parseYaml } = require("yaml");

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {Record<string, any>} */
  const out = { allowNonEvidence: false, allowFailedChecks: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--run") out.run = argv[++i];
    else if (a === "--manifest") out.manifest = argv[++i];
    else if (a === "--as") out.as = argv[++i];
    else if (a === "--allow-non-evidence") out.allowNonEvidence = true;
    else if (a === "--allow-failed-checks") out.allowFailedChecks = true;
    else if (a === "--force") out.force = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.run) throw new Error("--run <raw-run-dir | run-id> is required");
  if (out.as && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(out.as)) throw new Error(`invalid --as name: ${out.as}`);
  return out;
}

/** @param {string} run */
function resolveRunDir(run) {
  const direct = isAbsolute(run) ? run : join(root, run);
  if (existsSync(join(direct, "summary.json"))) return direct;
  const base = join(root, "live/reports/case-studies");
  const hits = existsSync(base)
    ? readdirSync(base)
        .map((study) => join(base, study, run))
        .filter((p) => existsSync(join(p, "summary.json")))
    : [];
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`run id ${run} is ambiguous: ${hits.join(", ")}`);
  throw new Error(`no summary.json for run ${run}`);
}

/**
 * @param {Record<string, any>} opts parsed args
 * @returns {{ summaryPath: string, recordPath: string, record: Record<string, any> }}
 */
export function promote(opts) {
  const runDir = resolveRunDir(opts.run);
  const body = readFileSync(join(runDir, "summary.json"));
  const sha = createHash("sha256").update(body).digest("hex");
  const shaFile = join(runDir, "summary.sha256");
  if (!existsSync(shaFile)) throw new Error(`missing ${relative(root, shaFile)}`);
  const recorded = readFileSync(shaFile, "utf8").trim().split(/\s+/)[0];
  if (recorded !== sha) throw new Error("summary.json does not match summary.sha256 (modified after the run?)");
  const summary = JSON.parse(body.toString("utf8"));
  const prov = summary.provenance ?? {};

  /** @type {string[]} */
  const overrides = [];
  if (prov.mode !== "live") {
    throw new Error(`refusing to promote a ${prov.mode ?? "unknown"}-mode run: recorded traces are not evidence`);
  }
  if (prov.evidence !== true) {
    if (!opts.allowNonEvidence) {
      throw new Error(
        `refusing to promote a non-evidence run (${prov.evidence_reason ?? "evidence flag missing"}); ` +
          "pass --allow-non-evidence to promote it marked as such",
      );
    }
    overrides.push("allow_non_evidence");
  }
  const invariantsOk = summary.invariants?.ok !== false;
  const complete = summary.accounting ? summary.accounting.complete === true : null;
  if (!invariantsOk || complete === false) {
    if (!opts.allowFailedChecks) {
      throw new Error(
        `refusing to promote: ${!invariantsOk ? "invariants failed" : ""}${!invariantsOk && complete === false ? " + " : ""}${complete === false ? "plan not fully accounted" : ""}; pass --allow-failed-checks to override`,
      );
    }
    overrides.push("allow_failed_checks");
  }

  const manifestRel = opts.manifest ?? prov.manifest_path;
  if (!manifestRel) throw new Error("cannot locate the study manifest (pass --manifest)");
  const manifestPath = isAbsolute(manifestRel) ? manifestRel : join(root, manifestRel);
  const manifest = parseYaml(readFileSync(manifestPath, "utf8"));
  const summaryRel = manifest.outputs?.summary;
  if (!summaryRel) throw new Error("manifest has no outputs.summary (results location)");
  const resultsDir = dirname(isAbsolute(summaryRel) ? summaryRel : join(root, summaryRel));
  const name = opts.as ?? prov.run_id ?? basename(runDir);
  const summaryPath = join(resultsDir, `${name}.summary.json`);
  const recordPath = join(resultsDir, `${name}.promotion.json`);
  if ((existsSync(summaryPath) || existsSync(recordPath)) && !opts.force) {
    throw new Error(`${relative(root, summaryPath)} exists; frozen results are not overwritten (pass --force)`);
  }
  if (opts.force) overrides.push("force_overwrite");

  const record = {
    schema: "case-study-promotion.v1",
    promoted_at: new Date().toISOString(),
    promoted_by: "scripts/promote-run.mjs",
    run_id: prov.run_id ?? null,
    study_id: prov.study_id ?? manifest.study_id ?? null,
    source_run_dir: relative(root, runDir),
    summary_sha256: sha,
    evidence: prov.evidence === true,
    evidence_reason: prov.evidence_reason ?? null,
    invariants_ok: invariantsOk,
    accounting_complete: complete,
    commit_sha: prov.code_state?.commit_sha ?? prov.commit_sha ?? null,
    dirty: prov.code_state?.dirty ?? null,
    diff_sha256: prov.code_state?.diff_sha256 ?? null,
    input_digest: prov.input_digest ?? null,
    runtime: prov.runtime ?? null,
    kit_models: prov.kit_models ?? null,
    overrides,
  };
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(summaryPath, body);
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n");
  return { summaryPath, recordPath, record };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const r = promote(parseArgs(process.argv.slice(2)));
    console.log(
      JSON.stringify(
        { promoted: relative(root, r.summaryPath), record: relative(root, r.recordPath), overrides: r.record.overrides },
        null,
        2,
      ),
    );
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
