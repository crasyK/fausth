/**
 * SWE-bench grading semantics — port of upstream SWE-bench v4.1.0
 * (`swebench/harness/grading.py`, `test_spec/python.py::get_test_directives`,
 * `utils.py::get_modified_files`). Pure functions, no I/O.
 */
import { TestStatus } from "./log-parsers.mjs";

/** upstream NON_TEST_EXTS (verbatim, including the dot-less "csv" quirk). */
export const NON_TEST_EXTS = [
  ".json",
  ".png",
  "csv",
  ".txt",
  ".md",
  ".jpg",
  ".jpeg",
  ".pkl",
  ".yml",
  ".yaml",
  ".toml",
];

export const START_TEST_OUTPUT = ">>>>> Start Test Output";
export const END_TEST_OUTPUT = ">>>>> End Test Output";

/**
 * Parse a JSON-ish list field from task.yml (SWE-bench stores FAIL_TO_PASS /
 * PASS_TO_PASS as JSON strings).
 * @param {unknown} v
 * @returns {string[]}
 */
export function asTestList(v) {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    const parsed = JSON.parse(v);
    if (!Array.isArray(parsed)) throw new Error("test list must be a JSON array");
    return parsed.map(String);
  }
  if (v == null) return [];
  throw new Error(`unsupported test list value: ${typeof v}`);
}

/**
 * Split a unified diff into per-file sections.
 * @param {string} patch
 * @returns {{ header: string, aPath: string | null, bPath: string | null, text: string, isNew: boolean, isDeleted: boolean }[]}
 */
export function splitPatchFiles(patch) {
  const text = String(patch ?? "");
  if (!text.trim()) return [];
  const starts = [];
  const re = /^diff --git /gm;
  let m;
  while ((m = re.exec(text))) starts.push(m.index);
  /** @type {ReturnType<typeof splitPatchFiles>} */
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const chunk = text.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : text.length);
    const firstLine = chunk.split("\n", 1)[0];
    const hm = /^diff --git a\/(.*?) b\/(.*)$/.exec(firstLine);
    let aPath = hm ? hm[1] : null;
    let bPath = hm ? hm[2] : null;
    const minus = /^--- (.*)$/m.exec(chunk);
    const plus = /^\+\+\+ (.*)$/m.exec(chunk);
    const clean = (p) => p.replace(/\t.*$/, "").trim();
    let isNew = /^new file mode /m.test(chunk);
    let isDeleted = /^deleted file mode /m.test(chunk);
    if (minus) {
      const s = clean(minus[1]);
      if (s === "/dev/null") isNew = true;
      else if (s.startsWith("a/")) aPath = s.slice(2);
    }
    if (plus) {
      const s = clean(plus[1]);
      if (s === "/dev/null") isDeleted = true;
      else if (s.startsWith("b/")) bPath = s.slice(2);
    }
    out.push({ header: firstLine, aPath, bPath, text: chunk, isNew, isDeleted });
  }
  return out;
}

/**
 * upstream get_modified_files: source files (a/ side) that exist before the patch.
 * @param {string} patch
 */
export function getModifiedFiles(patch) {
  return splitPatchFiles(patch)
    .filter((f) => !f.isNew && f.aPath)
    .map((f) => /** @type {string} */ (f.aPath));
}

/**
 * upstream get_test_directives (python repos).
 * @param {string} repo
 * @param {string} testPatch
 */
export function getTestDirectives(repo, testPatch) {
  const directives = [];
  for (const m of String(testPatch).matchAll(/diff --git a\/.* b\/(.*)/g)) directives.push(m[1]);
  let out = directives.filter((d) => !NON_TEST_EXTS.some((ext) => d.endsWith(ext)));
  if (repo === "django/django") {
    out = out.map((d) => {
      let x = d.endsWith(".py") ? d.slice(0, -3) : d;
      x = x.startsWith("tests/") ? x.slice("tests/".length) : x;
      return x.replaceAll("/", ".");
    });
  }
  return out;
}

/** @param {string} c @param {Record<string,string>} sm */
export function testPassed(c, sm) {
  return Object.hasOwn(sm, c) && (sm[c] === TestStatus.PASSED || sm[c] === TestStatus.XFAIL);
}

/** @param {string} c @param {Record<string,string>} sm */
export function testFailed(c, sm) {
  return !Object.hasOwn(sm, c) || sm[c] === TestStatus.FAILED || sm[c] === TestStatus.ERROR;
}

/**
 * upstream get_eval_tests_report (PASS_AND_FAIL eval type).
 * @param {Record<string,string>} statusMap
 * @param {{ FAIL_TO_PASS: string[], PASS_TO_PASS: string[] }} gold
 */
export function getEvalTestsReport(statusMap, gold) {
  const f2pSuccess = [];
  const f2pFailure = [];
  const p2pSuccess = [];
  const p2pFailure = [];
  for (const c of gold.FAIL_TO_PASS) {
    if (testPassed(c, statusMap)) f2pSuccess.push(c);
    else if (testFailed(c, statusMap)) f2pFailure.push(c);
  }
  for (const c of gold.PASS_TO_PASS) {
    if (testPassed(c, statusMap)) p2pSuccess.push(c);
    else if (testFailed(c, statusMap)) p2pFailure.push(c);
  }
  return {
    FAIL_TO_PASS: { success: f2pSuccess, failure: f2pFailure },
    PASS_TO_PASS: { success: p2pSuccess, failure: p2pFailure },
  };
}

function ratio(part) {
  const total = part.success.length + part.failure.length;
  return total === 0 ? 1 : part.success.length / total;
}

/** upstream get_resolution_status → RESOLVED_FULL | RESOLVED_PARTIAL | RESOLVED_NO */
export function getResolutionStatus(report) {
  const f2p = ratio(report.FAIL_TO_PASS);
  const p2p = ratio(report.PASS_TO_PASS);
  if (f2p === 1 && p2p === 1) return "RESOLVED_FULL";
  if (f2p < 1 && f2p > 0 && p2p === 1) return "RESOLVED_PARTIAL";
  return "RESOLVED_NO";
}

/**
 * Extract the test section between upstream markers; fall back to the whole
 * log when the parser finds nothing there (upstream behaviour).
 * @param {string} log
 * @param {(s: string) => Record<string,string>} parser
 */
export function parseEvalLog(log, parser) {
  const s = log.indexOf(START_TEST_OUTPUT);
  const e = log.indexOf(END_TEST_OUTPUT, s + 1);
  if (s < 0 || e < 0) return { markers: false, statusMap: {} };
  const section = log.slice(s + START_TEST_OUTPUT.length, e);
  let statusMap = parser(section);
  if (!Object.keys(statusMap).length) statusMap = parser(log);
  return { markers: true, statusMap };
}

/**
 * Classify a repo-relative path as a test file (used to keep agents from
 * grading themselves by editing tests). Files touched by the gold test patch
 * are always test files; otherwise use conservative name rules.
 * @param {string} path
 * @param {Set<string>} testPatchFiles
 */
export function isTestPath(path, testPatchFiles = new Set()) {
  if (testPatchFiles.has(path)) return true;
  const parts = path.split("/");
  const base = parts[parts.length - 1] ?? "";
  if (/^test_.*\.py$/.test(base)) return true;
  if (/_tests?\.py$/.test(base)) return true;
  if (base === "tests.py" || base === "conftest.py") return true;
  return parts.slice(0, -1).includes("tests");
}
