#!/usr/bin/env node
/**
 * SWE grader self-test: for each task, build its environment and check
 *   gold patch  ⇒ FAIL_TO_PASS pass and PASS_TO_PASS pass (RESOLVED_FULL)
 *   empty patch ⇒ every FAIL_TO_PASS test fails
 * Tasks failing either check (or whose env cannot be built without root/Docker)
 * are `grader_unavailable`: excluded from scoring and reported, never counted
 * as model failures.
 *
 * Usage:
 *   node case-studies/swe-bench/world/selftest.mjs --tasks django__django-10914,pallets__flask-4045
 *   node case-studies/swe-bench/world/selftest.mjs --all --jobs 2 --write-report
 *   node case-studies/swe-bench/world/selftest.mjs --report-only     # rebuild GRADER-VALIDATION.md from envs
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEnv, envDirFor, envFingerprint, loadEnvRecord, loadSweTask, REPO_ROOT, specFor, SWE_WORLD_DIR } from "./env.mjs";
import { evaluatePatch } from "./eval.mjs";

export const TASKS_DIR = join(REPO_ROOT, "case-studies", "swe-bench", "tasks");

export function selftestPath(instanceId) {
  return join(envDirFor(instanceId), "selftest.json");
}

function summarize(res) {
  if (!res || res.status !== "graded") {
    return { status: res?.status ?? "missing", reason: res?.reason ?? null, log_path: res?.log_path ?? null };
  }
  const cap = (xs) => xs.slice(0, 20);
  return {
    status: res.status,
    patch_applied: res.patch_applied,
    resolution: res.resolution,
    f2p_success: res.report.FAIL_TO_PASS.success.length,
    f2p_failure: res.report.FAIL_TO_PASS.failure.length,
    p2p_success: res.report.PASS_TO_PASS.success.length,
    p2p_failure: res.report.PASS_TO_PASS.failure.length,
    f2p_failures: cap(res.report.FAIL_TO_PASS.failure),
    p2p_failures: cap(res.report.PASS_TO_PASS.failure),
    f2p_passes: cap(res.report.FAIL_TO_PASS.success),
    parsed_tests: res.parsed_tests ?? null,
    timed_out: res.timed_out,
    seconds: res.seconds,
    log_path: res.log_path,
  };
}

/** Load a cached self-test result valid for this exact env build. */
export function loadSelftest(record) {
  const p = selftestPath(record.instance_id);
  if (!existsSync(p)) return null;
  try {
    const st = JSON.parse(readFileSync(p, "utf8"));
    if (st.fingerprint !== record.fingerprint || st.env_head !== record.env_head) return null;
    return st;
  } catch {
    return null;
  }
}

/** Run gold + empty evaluations and persist the verdict next to the env. */
export function runSelftest(task, record) {
  const gold = evaluatePatch(task, record, task.gold_patch ?? "", { label: "selftest-gold" });
  const empty = evaluatePatch(task, record, "", { label: "selftest-empty" });
  const goldOk = gold.status === "graded" && gold.resolution === "RESOLVED_FULL";
  // "empty ⇒ F2P fail": the FAIL_TO_PASS criterion must fail without the fix
  // (≥1 F2P test fails, so a no-op can never be RESOLVED_FULL). F2P tests that
  // already pass at base are reported (`f2p_success` of the empty run).
  const emptyOk = empty.status === "graded" && empty.report.FAIL_TO_PASS.failure.length > 0;
  const reasons = [];
  if (!goldOk) {
    reasons.push(
      gold.status !== "graded"
        ? `gold: ${gold.reason}`
        : `gold patch not resolved (${gold.resolution}; F2P fail ${gold.report.FAIL_TO_PASS.failure.length}, P2P fail ${gold.report.PASS_TO_PASS.failure.length})`,
    );
  }
  if (!emptyOk) {
    reasons.push(
      empty.status !== "graded"
        ? `empty: ${empty.reason}`
        : `empty patch passes all ${empty.report.FAIL_TO_PASS.success.length} FAIL_TO_PASS test(s)`,
    );
  }
  const st = {
    instance_id: task.id,
    ok: goldOk && emptyOk,
    reasons,
    fingerprint: record.fingerprint,
    env_head: record.env_head,
    python: record.python,
    gold: summarize(gold),
    empty: summarize(empty),
    at: new Date().toISOString(),
  };
  writeFileSync(selftestPath(task.id), JSON.stringify(st, null, 2) + "\n");
  return st;
}

/**
 * Grader entry point: env built + self-test passed, else grader_unavailable.
 * @param {ReturnType<typeof loadSweTask>} task
 * @param {{ autobuild?: boolean, log?: (s: string) => void }} [opts]
 */
export function ensureValidated(task, opts = {}) {
  const autobuild = opts.autobuild ?? process.env.FAUSTH_SWE_ENV_AUTOBUILD !== "0";
  if (task.integrity_errors?.length) {
    return { ok: false, reason: `oracle integrity: ${task.integrity_errors.join("; ")}` };
  }
  let current;
  try {
    current = envFingerprint(task, specFor(task));
  } catch (e) {
    return { ok: false, reason: `no environment recipe for this task: ${e?.message ?? e}` };
  }
  let record = loadEnvRecord(task.id);
  if (record && record.fingerprint !== current) {
    // built with an outdated recipe: never grade with it
    record = autobuild ? buildEnv(task, { log: opts.log }) : null;
    if (!record) return { ok: false, reason: "environment built with an outdated recipe (rebuild with selftest.mjs)" };
  }
  if (!record && autobuild) record = buildEnv(task, { log: opts.log });
  if (!record) return { ok: false, reason: "environment not built (run selftest.mjs or set FAUSTH_SWE_ENV_AUTOBUILD=1)" };
  if (!record.ok) return { ok: false, record, reason: `environment build failed at ${record.failed_step}` };
  let st = loadSelftest(record);
  if (!st && autobuild) st = runSelftest(task, record);
  if (!st) return { ok: false, record, reason: "grader self-test not run for this environment" };
  if (!st.ok) return { ok: false, record, selftest: st, reason: `grader self-test failed: ${st.reasons.join("; ")}` };
  return { ok: true, record, selftest: st };
}

function listTaskIds() {
  return readdirSync(TASKS_DIR)
    .filter((d) => existsSync(join(TASKS_DIR, d, "task.yml")))
    .sort();
}

/** One task end-to-end (build + self-test); returns a compact row. */
export function selftestTask(id, { rebuild = false, log = console.error } = {}) {
  const task = loadSweTask(join(TASKS_DIR, id));
  if (task.integrity_errors.length) {
    return { instance_id: id, repo: task.repo, version: task.version, verdict: "grader_unavailable", reason: task.integrity_errors.join("; ") };
  }
  const record = buildEnv(task, { force: rebuild, log });
  if (!record.ok) {
    return {
      instance_id: id,
      repo: task.repo,
      version: task.version,
      verdict: "grader_unavailable",
      reason: `env build failed at ${record.failed_step}: ${String(record.error).split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 400)}`,
      env: { python_spec: null, build_seconds: record.build_seconds, pip_failures: record.pip_failures, skipped: record.skipped },
    };
  }
  log(`[selftest ${id}] env ok (python ${record.python}, ${record.build_seconds}s); evaluating gold + empty`);
  const st = runSelftest(task, record);
  return {
    instance_id: id,
    repo: task.repo,
    version: task.version,
    verdict: st.ok ? "validated" : "grader_unavailable",
    reason: st.ok ? null : st.reasons.join("; "),
    env: {
      python: record.python,
      python_spec: record.python_spec,
      cached_env_yml: record.cached_env_yml,
      build_seconds: record.build_seconds,
      pip_failures: record.pip_failures,
      skipped: record.skipped,
    },
    gold: st.gold,
    empty: st.empty,
  };
}

function collectRowsFromEnvs(ids) {
  const rows = [];
  for (const id of ids) {
    const task = loadSweTask(join(TASKS_DIR, id));
    const record = loadEnvRecord(id);
    if (!record) {
      rows.push({ instance_id: id, repo: task.repo, version: task.version, verdict: "not_run", reason: "environment not built on this host" });
      continue;
    }
    if (record.fingerprint !== envFingerprint(task, specFor(task))) {
      rows.push({ instance_id: id, repo: task.repo, version: task.version, verdict: "not_run", reason: "environment built with an outdated recipe" });
      continue;
    }
    if (!record.ok) {
      rows.push({
        instance_id: id,
        repo: task.repo,
        version: task.version,
        verdict: "grader_unavailable",
        reason: `env build failed at ${record.failed_step}: ${String(record.error).split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 400)}`,
        env: { build_seconds: record.build_seconds, pip_failures: record.pip_failures, skipped: record.skipped },
      });
      continue;
    }
    const st = loadSelftest(record);
    rows.push({
      instance_id: id,
      repo: task.repo,
      version: task.version,
      verdict: !st ? "not_run" : st.ok ? "validated" : "grader_unavailable",
      reason: !st ? "self-test not run" : st.ok ? null : st.reasons.join("; "),
      env: {
        python: record.python,
        python_spec: record.python_spec,
        cached_env_yml: record.cached_env_yml,
        build_seconds: record.build_seconds,
        pip_failures: record.pip_failures,
        skipped: record.skipped,
      },
      gold: st?.gold ?? null,
      empty: st?.empty ?? null,
    });
  }
  return rows;
}

function fmtCounts(s) {
  if (!s || s.status !== "graded") return s ? `${s.status}${s.reason ? ` (${s.reason})` : ""}` : "—";
  return `${s.resolution}; F2P ${s.f2p_success}/${s.f2p_success + s.f2p_failure} pass; P2P ${s.p2p_success}/${s.p2p_success + s.p2p_failure} pass`;
}

export function writeReport(rows) {
  const json = {
    generated_at: new Date().toISOString(),
    host_note: "Results are for environments built on this host (no Docker, no root, conda-forge via micromamba). Re-run selftest.mjs on any other host before trusting grades there.",
    criteria: {
      gold: "gold patch ⇒ RESOLVED_FULL (all FAIL_TO_PASS and PASS_TO_PASS pass)",
      empty: "empty patch ⇒ FAIL_TO_PASS criterion fails (≥1 F2P test fails)",
    },
    rows,
  };
  writeFileSync(join(SWE_WORLD_DIR, "grader-validation.json"), JSON.stringify(json, null, 2) + "\n");
  const validated = rows.filter((r) => r.verdict === "validated");
  const unavailable = rows.filter((r) => r.verdict === "grader_unavailable");
  const notRun = rows.filter((r) => r.verdict === "not_run");
  const repos = new Set(validated.map((r) => r.repo));
  const lines = [];
  lines.push("# SWE-bench grader validation");
  lines.push("");
  lines.push(`Generated by \`node case-studies/swe-bench/world/selftest.mjs\` on ${json.generated_at.slice(0, 10)}. Machine-readable: [\`world/grader-validation.json\`](world/grader-validation.json).`);
  lines.push("");
  lines.push("Self-test criteria (per task, in its own environment):");
  lines.push("");
  lines.push("- **gold** — upstream gold `patch` applied ⇒ `RESOLVED_FULL` (every FAIL_TO_PASS and PASS_TO_PASS test passes, upstream SWE-bench v4.1.0 grading rules).");
  lines.push("- **empty** — no patch ⇒ the FAIL_TO_PASS criterion fails (≥1 FAIL_TO_PASS test fails, so a no-op can never be `RESOLVED_FULL`). F2P tests that already pass at base are shown in the Empty column (e.g. network-dependent upstream tests).");
  lines.push("");
  lines.push(`**Validated: ${validated.length}/${rows.length}** tasks across ${repos.size} repos (${[...repos].sort().join(", ") || "none"}). ` +
    `**grader_unavailable: ${unavailable.length}**. Not run on this host: ${notRun.length}.`);
  lines.push("");
  lines.push("Only `validated` tasks may be graded; `grader_unavailable` tasks are excluded from task-success denominators and reported separately (never counted as model failures). The grader enforces this at runtime (`ensureValidated` in `world/selftest.mjs`).");
  lines.push("");
  lines.push("| Task | Repo@version | Python (spec → used) | Verdict | Gold | Empty | Notes |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const py = r.env?.python ? `${r.env.python_spec ?? "?"} → ${r.env.python}` : "—";
    const notes = [];
    if (r.reason) notes.push(r.reason.replace(/\|/g, "\\|").slice(0, 300));
    if (r.env?.cached_env_yml) notes.push("upstream cached environment.yml");
    if (r.env?.pip_failures?.length) {
      notes.push(`pip/conda skipped: ${r.env.pip_failures.map((f) => f.package).slice(0, 6).join(", ")}${r.env.pip_failures.length > 6 ? ", …" : ""}`);
    }
    lines.push(
      `| \`${r.instance_id}\` | ${r.repo}@${r.version} | ${py} | **${r.verdict}** | ${fmtCounts(r.gold)} | ${fmtCounts(r.empty)} | ${notes.join("; ") || ""} |`,
    );
  }
  lines.push("");
  lines.push("## Environment recipe and deviations from upstream");
  lines.push("");
  lines.push("- Specs: [`world/upstream-specs.json`](world/upstream-specs.json) — SWE-bench v4.1.0 (`726c5461`) `MAP_REPO_VERSION_TO_SPECS_PY`, unmodified. Cached upstream lockfiles: [`world/envs/`](world/envs/).");
  lines.push("- No Docker/root: conda envs via a pinned, sha256-verified micromamba (conda-forge only), testbed = `git clone --shared` of the `live/cache/swe` mirror at `base_commit`, setup edits committed as upstream does (`env_head`).");
  lines.push("- `apt-get` / `/etc` / `locale-gen` pre-install lines are skipped (recorded per env); matplotlib gets conda-forge `freetype` + `pkg-config` instead of apt packages.");
  lines.push("- Cached upstream `environment.yml` lockfiles: python version kept exactly; python libraries pinned via pip at the lockfile versions; system libraries come from wheels.");
  lines.push("- Test runs use a scrubbed environment (no API keys), `HOME` inside the env dir, and the repo-specific upstream test command + log parser.");
  lines.push("");
  lines.push("Reproduce: `node case-studies/swe-bench/world/selftest.mjs --all --jobs 2 --write-report` (envs under `$FAUSTH_SWE_ENV_ROOT`, default `~/.cache/fausth/swe-env`).");
  lines.push("");
  writeFileSync(join(SWE_WORLD_DIR, "..", "GRADER-VALIDATION.md"), lines.join("\n"));
}

async function runChildren(ids, jobs, rebuild) {
  const rows = [];
  const queue = [...ids];
  const self = fileURLToPath(import.meta.url);
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      const row = await new Promise((resolveRow) => {
        const args = [self, "--child", id];
        if (rebuild) args.push("--rebuild");
        const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.on("close", (code) => {
          try {
            resolveRow(JSON.parse(out.trim().split("\n").pop()));
          } catch {
            resolveRow({ instance_id: id, verdict: "grader_unavailable", reason: `self-test process exited ${code}` });
          }
        });
      });
      console.error(`[selftest] ${row.instance_id}: ${row.verdict}${row.reason ? ` — ${row.reason}` : ""}`);
      rows.push(row);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
  return rows;
}

async function main(argv) {
  const args = { tasks: null, all: false, jobs: 1, rebuild: false, write: false, reportOnly: false, child: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tasks") args.tasks = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--all") args.all = true;
    else if (a === "--jobs") args.jobs = Number(argv[++i]);
    else if (a === "--rebuild") args.rebuild = true;
    else if (a === "--write-report") args.write = true;
    else if (a === "--report-only") args.reportOnly = true;
    else if (a === "--child") args.child = argv[++i];
  }
  if (args.child) {
    const row = selftestTask(args.child, { rebuild: args.rebuild });
    process.stdout.write(JSON.stringify(row) + "\n");
    return;
  }
  const ids = args.all || args.reportOnly ? listTaskIds() : args.tasks ?? [];
  if (!ids.length) {
    console.error("usage: selftest.mjs --tasks <ids> | --all [--jobs N] [--rebuild] [--write-report] | --report-only");
    process.exit(2);
  }
  if (!args.reportOnly) await runChildren(ids, args.jobs, args.rebuild);
  const rows = collectRowsFromEnvs(args.all || args.reportOnly ? listTaskIds() : ids);
  if (args.write || args.reportOnly) writeReport(collectRowsFromEnvs(listTaskIds()));
  process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
