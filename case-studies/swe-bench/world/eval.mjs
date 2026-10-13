/**
 * Evaluate a patch against a SWE-bench task inside its per-task environment —
 * the no-Docker equivalent of upstream `make_eval_script_list_py` +
 * `get_logs_eval` + `get_eval_report` (SWE-bench v4.1.0).
 *
 * Order (as upstream): reset testbed → apply model patch → install → reset the
 * test-patch files to base_commit → apply the gold test_patch → run the
 * repo-specific test command on the test directives → parse the log with the
 * repo-specific parser → FAIL_TO_PASS / PASS_TO_PASS report.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  condaEnv,
  envDirFor,
  envRoot,
  loadUpstreamSpecs,
  runBash,
  withDirLock,
} from "./env.mjs";
import {
  END_TEST_OUTPUT,
  START_TEST_OUTPUT,
  asTestList,
  getEvalTestsReport,
  getModifiedFiles,
  getResolutionStatus,
  getTestDirectives,
  parseEvalLog,
} from "./grading.mjs";
import { MAP_REPO_TO_PARSER } from "./log-parsers.mjs";

export const APPLY_PATCH_FAIL = ">>>>> Patch Apply Failed";
export const APPLY_PATCH_PASS = ">>>>> Applied Patch";
export const RESET_FAILED = ">>>>> Reset Failed";
export const TEST_PATCH_FAIL = ">>>>> Test Patch Apply Failed";
export const DEFAULT_EVAL_TIMEOUT_MS = 1800_000;

function q(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Export lines of upstream eval_commands that do not need root. */
function evalExports(spec) {
  const out = [];
  for (const line of spec.eval_commands ?? []) {
    if (/^export\s/.test(line)) out.push(line);
  }
  return out;
}

/** Shell snippet: reset the testbed to the env head (keeps ignored build artefacts). */
function resetSnippet(record) {
  return `git reset -q --hard ${q(record.env_head)} && git clean -fdq`;
}

/**
 * Bash snippet applying a patch file with upstream's fallback chain
 * (git apply → git apply --reject → patch --fuzz=5), resetting between tries.
 */
export function applyPatchSnippet(record, patchFile) {
  return [
    `if git apply --verbose ${q(patchFile)}; then echo ${q(APPLY_PATCH_PASS)};`,
    `elif ${resetSnippet(record)} && git apply --verbose --reject ${q(patchFile)}; then echo ${q(APPLY_PATCH_PASS)};`,
    `elif ${resetSnippet(record)} && patch --batch --fuzz=5 -p1 -i ${q(patchFile)}; then echo ${q(APPLY_PATCH_PASS)};`,
    `else echo ${q(APPLY_PATCH_FAIL)}; ${resetSnippet(record)}; exit 0; fi`,
  ].join("\n");
}

/**
 * @param {{ id: string, repo: string, version: string, base_commit: string, FAIL_TO_PASS: unknown, PASS_TO_PASS: unknown, test_patch: string | null }} task
 * @param {Record<string, any>} record env record (ok=true)
 * @param {string} modelPatch unified diff (may be empty)
 * @param {{ label?: string, timeoutMs?: number }} [opts]
 */
export function evaluatePatch(task, record, modelPatch, opts = {}) {
  const label = String(opts.label ?? "eval").replace(/[^A-Za-z0-9._-]+/g, "_");
  if (!record?.ok) {
    return { status: "grader_unavailable", reason: `env not built: ${record?.failed_step ?? "missing"}` };
  }
  if (task.test_patch == null || !task.test_patch.trim()) {
    return { status: "grader_unavailable", reason: "missing oracle/test_patch.diff" };
  }
  const parser = MAP_REPO_TO_PARSER[task.repo];
  if (!parser) return { status: "grader_unavailable", reason: `no log parser for ${task.repo}` };
  const spec = loadUpstreamSpecs().specs[task.repo][task.version];
  const f2p = asTestList(task.FAIL_TO_PASS);
  const p2p = asTestList(task.PASS_TO_PASS);
  const testFiles = getModifiedFiles(task.test_patch);
  const directives = getTestDirectives(task.repo, task.test_patch);

  const evalDir = join(envDirFor(task.id), "evals");
  mkdirSync(evalDir, { recursive: true });
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${label}`;
  const modelPatchFile = join(evalDir, `${stamp}.model.diff`);
  const testPatchFile = join(evalDir, `${stamp}.test.diff`);
  const logFile = join(evalDir, `${stamp}.log`);
  writeFileSync(modelPatchFile, modelPatch ?? "");
  writeFileSync(testPatchFile, task.test_patch);

  const checkoutTests = testFiles.length
    ? `git checkout ${q(task.base_commit)} -- ${testFiles.map(q).join(" ")}`
    : ":";
  const script = [
    "set -u",
    `cd ${q(record.testbed)}`,
    `${resetSnippet(record)} || { echo ${q(RESET_FAILED)}; exit 0; }`,
    modelPatch && modelPatch.trim() ? applyPatchSnippet(record, modelPatchFile) : `echo "(empty model patch)"`,
    ...evalExports(spec),
    "git -c core.fileMode=false diff --stat",
    spec.install ? spec.install : ":",
    checkoutTests,
    `git apply -v ${q(testPatchFile)} || { echo ${q(TEST_PATCH_FAIL)}; ${resetSnippet(record)}; exit 0; }`,
    `echo ${q(START_TEST_OUTPUT)}`,
    [spec.test_cmd, ...directives.map(q)].join(" "),
    `echo ">>>>> Test Exit Code $?"`,
    `echo ${q(END_TEST_OUTPUT)}`,
    checkoutTests,
    resetSnippet(record),
  ].join("\n");

  const timeoutMs = Number(opts.timeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS);
  const started = Date.now();
  mkdirSync(join(envDirFor(task.id), "home"), { recursive: true });
  const res = withDirLock(join(envRoot(), ".locks", `${task.id}.testbed`), timeoutMs + 3600_000, () => {
    const r = runBash(script, {
      cwd: record.testbed,
      env: condaEnv(record, { HOME: join(envDirFor(task.id), "home"), MPLBACKEND: "Agg" }),
      timeoutMs,
      logFile,
      label: `eval ${label}`,
    });
    if (r.timedOut) {
      // leave the testbed clean for the next evaluation
      runBash(`cd ${q(record.testbed)} && ${resetSnippet(record)}`, { env: condaEnv(record) });
    }
    return r;
  });
  const out = res.output;
  const base = {
    log_path: logFile,
    seconds: Math.round((Date.now() - started) / 1000),
    test_directives: directives,
    timed_out: res.timedOut,
  };
  if (out.includes(RESET_FAILED)) return { ...base, status: "grader_unavailable", reason: "testbed reset failed" };
  if (out.includes(TEST_PATCH_FAIL)) {
    return { ...base, status: "grader_unavailable", reason: "gold test_patch did not apply" };
  }
  if (out.includes(APPLY_PATCH_FAIL)) {
    const report = getEvalTestsReport({}, { FAIL_TO_PASS: f2p, PASS_TO_PASS: p2p });
    return {
      ...base,
      status: "graded",
      patch_applied: false,
      resolution: "RESOLVED_NO",
      resolved: false,
      report,
    };
  }
  const { markers, statusMap } = parseEvalLog(out, parser);
  if (!markers) {
    if (res.timedOut) {
      const report = getEvalTestsReport({}, { FAIL_TO_PASS: f2p, PASS_TO_PASS: p2p });
      return { ...base, status: "graded", patch_applied: true, resolution: "RESOLVED_NO", resolved: false, report };
    }
    return { ...base, status: "grader_unavailable", reason: "eval script ended before test output markers" };
  }
  const report = getEvalTestsReport(statusMap, { FAIL_TO_PASS: f2p, PASS_TO_PASS: p2p });
  const resolution = getResolutionStatus(report);
  const exitMatch = /^>>>>> Test Exit Code (\d+)/m.exec(out);
  return {
    ...base,
    status: "graded",
    patch_applied: true,
    resolution,
    resolved: resolution === "RESOLVED_FULL",
    report,
    parsed_tests: Object.keys(statusMap).length,
    test_exit_code: exitMatch ? Number(exitMatch[1]) : null,
  };
}
