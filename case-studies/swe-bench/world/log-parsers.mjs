/**
 * SWE-bench test-log parsers — 1:1 port of upstream
 * `swebench/harness/log_parsers/python.py` (SWE-bench v4.1.0, commit 726c5461).
 *
 * Each parser maps a raw test log to `{ [testName]: status }` with statuses
 * PASSED / FAILED / SKIPPED / ERROR / XFAIL. Test names are matched verbatim
 * against the task's FAIL_TO_PASS / PASS_TO_PASS lists, so the parsing rules
 * (including upstream quirks) must not be "improved" here.
 */

export const TestStatus = Object.freeze({
  FAILED: "FAILED",
  PASSED: "PASSED",
  SKIPPED: "SKIPPED",
  ERROR: "ERROR",
  XFAIL: "XFAIL",
});

const STATUS_VALUES = Object.values(TestStatus);

/** Python `str.split()` with no arguments (whitespace runs, no empty tokens). */
function pySplit(line) {
  const t = line.trim();
  return t ? t.split(/\s+/) : [];
}

/** Python `str.strip()` (whitespace). */
function pyStrip(s) {
  return s.trim();
}

function startsWithStatus(line) {
  return STATUS_VALUES.some((v) => line.startsWith(v));
}

function endsWithStatus(line) {
  return STATUS_VALUES.some((v) => line.endsWith(v));
}

/** parse_log_pytest */
export function parseLogPytest(log) {
  /** @type {Record<string, string>} */
  const map = {};
  for (let line of log.split("\n")) {
    if (startsWithStatus(line)) {
      if (line.startsWith(TestStatus.FAILED)) line = line.replaceAll(" - ", " ");
      const tc = pySplit(line);
      if (tc.length <= 1) continue;
      map[tc[1]] = tc[0];
    }
  }
  return map;
}

/** parse_log_pytest_options */
export function parseLogPytestOptions(log) {
  const optionPattern = /(.*?)\[(.*)\]/;
  /** @type {Record<string, string>} */
  const map = {};
  for (let line of log.split("\n")) {
    if (startsWithStatus(line)) {
      if (line.startsWith(TestStatus.FAILED)) line = line.replaceAll(" - ", " ");
      const tc = pySplit(line);
      if (tc.length <= 1) continue;
      const m = optionPattern.exec(tc[1]);
      let name;
      if (m) {
        const main = m[1];
        let option = m[2];
        if (option.startsWith("/") && !option.startsWith("//") && !option.includes("*")) {
          const parts = option.split("/");
          option = "/" + parts[parts.length - 1];
        }
        name = `${main}[${option}]`;
      } else {
        name = tc[1];
      }
      map[name] = tc[0];
    }
  }
  return map;
}

/** parse_log_django */
export function parseLogDjango(log) {
  /** @type {Record<string, string>} */
  const map = {};
  let prevTest = null;
  for (const raw of log.split("\n")) {
    let line = pyStrip(raw);
    if (line.includes("--version is equivalent to version")) {
      map["--version is equivalent to version"] = TestStatus.PASSED;
    }
    if (line.includes(" ... ")) {
      prevTest = line.split(" ... ")[0];
    }
    const passSuffixes = [" ... ok", " ... OK", " ...  OK"];
    for (const suffix of passSuffixes) {
      if (line.endsWith(suffix)) {
        if (
          pyStrip(line).startsWith("Applying sites.0002_alter_domain_unique...test_no_migrations")
        ) {
          const idx = line.indexOf("...");
          line = pyStrip(line.slice(idx + 3));
        }
        // rsplit(suffix, 1)[0]
        const at = line.lastIndexOf(suffix);
        const test = at >= 0 ? line.slice(0, at) : line;
        map[test] = TestStatus.PASSED;
        break;
      }
    }
    if (line.includes(" ... skipped")) {
      map[line.split(" ... skipped")[0]] = TestStatus.SKIPPED;
    }
    if (line.endsWith(" ... FAIL")) {
      map[line.split(" ... FAIL")[0]] = TestStatus.FAILED;
    }
    if (line.startsWith("FAIL:")) {
      const parts = pySplit(line);
      if (parts.length > 1) map[pyStrip(parts[1])] = TestStatus.FAILED;
    }
    if (line.endsWith(" ... ERROR")) {
      map[line.split(" ... ERROR")[0]] = TestStatus.ERROR;
    }
    if (line.startsWith("ERROR:")) {
      const parts = pySplit(line);
      if (parts.length > 1) map[pyStrip(parts[1])] = TestStatus.ERROR;
    }
    if (line.replace(/^\s+/, "").startsWith("ok") && prevTest !== null) {
      map[prevTest] = TestStatus.PASSED;
    }
  }
  const patterns = [
    /^(.*?)\s\.\.\.\sTesting against Django installed in ([\s\S]*?) silenced\)\.\nok$/gm,
    /^(.*?)\s\.\.\.\sInternal Server Error: \/(.*)\/\nok$/gm,
    /^(.*?)\s\.\.\.\sSystem check identified no issues \(0 silenced\)\nok$/gm,
  ];
  for (const re of patterns) {
    for (const m of log.matchAll(re)) map[m[1]] = TestStatus.PASSED;
  }
  return map;
}

/** parse_log_pytest_v2 */
export function parseLogPytestV2(log) {
  /** @type {Record<string, string>} */
  const map = {};
  // eslint-disable-next-line no-control-regex
  const escapes = /[\x01-\x1f]/g;
  for (let line of log.split("\n")) {
    line = line.replace(/\[(\d+)m/g, "").replace(escapes, "");
    if (startsWithStatus(line)) {
      if (line.startsWith(TestStatus.FAILED)) line = line.replaceAll(" - ", " ");
      const tc = pySplit(line);
      if (tc.length >= 2) map[tc[1]] = tc[0];
    } else if (endsWithStatus(line)) {
      const tc = pySplit(line);
      if (tc.length >= 2) map[tc[0]] = tc[1];
    }
  }
  return map;
}

/** parse_log_seaborn */
export function parseLogSeaborn(log) {
  /** @type {Record<string, string>} */
  const map = {};
  for (const line of log.split("\n")) {
    if (line.startsWith(TestStatus.FAILED)) {
      const tc = pySplit(line);
      if (tc.length > 1) map[tc[1]] = TestStatus.FAILED;
    } else if (line.includes(` ${TestStatus.PASSED} `)) {
      const parts = pySplit(line);
      if (parts[1] === TestStatus.PASSED) map[parts[0]] = TestStatus.PASSED;
    } else if (line.startsWith(TestStatus.PASSED)) {
      const parts = pySplit(line);
      if (parts.length > 1) map[parts[1]] = TestStatus.PASSED;
    }
  }
  return map;
}

/** parse_log_sympy */
export function parseLogSympy(log) {
  /** @type {Record<string, string>} */
  const map = {};
  for (const m of log.matchAll(/(_*) (.*)\.py:(.*) (_*)/g)) {
    map[`${m[2]}.py:${m[3]}`] = TestStatus.FAILED;
  }
  for (const raw of log.split("\n")) {
    const line = pyStrip(raw);
    if (line.startsWith("test_")) {
      if (line.endsWith(" E")) map[pySplit(line)[0]] = TestStatus.ERROR;
      if (line.endsWith(" F")) map[pySplit(line)[0]] = TestStatus.FAILED;
      if (line.endsWith(" ok")) map[pySplit(line)[0]] = TestStatus.PASSED;
    }
  }
  return map;
}

/** parse_log_matplotlib */
export function parseLogMatplotlib(log) {
  /** @type {Record<string, string>} */
  const map = {};
  for (let line of log.split("\n")) {
    line = line.replaceAll("MouseButton.LEFT", "1").replaceAll("MouseButton.RIGHT", "3");
    if (startsWithStatus(line)) {
      if (line.startsWith(TestStatus.FAILED)) line = line.replaceAll(" - ", " ");
      const tc = pySplit(line);
      if (tc.length <= 1) continue;
      map[tc[1]] = tc[0];
    }
  }
  return map;
}

/** MAP_REPO_TO_PARSER_PY (subset used by case-studies/swe-bench). */
export const MAP_REPO_TO_PARSER = Object.freeze({
  "astropy/astropy": parseLogPytestV2,
  "django/django": parseLogDjango,
  "matplotlib/matplotlib": parseLogMatplotlib,
  "mwaskom/seaborn": parseLogSeaborn,
  "pallets/flask": parseLogPytest,
  "psf/requests": parseLogPytestOptions,
  "pydata/xarray": parseLogPytest,
  "pylint-dev/pylint": parseLogPytestOptions,
  "pytest-dev/pytest": parseLogPytest,
  "scikit-learn/scikit-learn": parseLogPytestV2,
  "sphinx-doc/sphinx": parseLogPytestV2,
  "sympy/sympy": parseLogSympy,
});
