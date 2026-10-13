/**
 * SWE-bench grading port (case-studies/swe-bench/world/*) — offline unit tests
 * of the upstream-faithful pieces, plus an integration check that runs only
 * when a validated environment exists on this host.
 *
 *   node --test case-studies/swe-bench/tests/swe-grading.test.mjs
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  asTestList,
  getEvalTestsReport,
  getModifiedFiles,
  getResolutionStatus,
  getTestDirectives,
  isTestPath,
  parseEvalLog,
  splitPatchFiles,
} from "../world/grading.mjs";
import {
  MAP_REPO_TO_PARSER,
  parseLogDjango,
  parseLogPytest,
  parseLogPytestOptions,
  parseLogPytestV2,
  parseLogSeaborn,
  parseLogSympy,
} from "../world/log-parsers.mjs";
import { cachedSystemLibs, loadEnvRecord, loadSweTask, specFor, splitEnvYml } from "../world/env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const tasksDir = join(here, "..", "tasks");

describe("SWE grading: upstream log parsers", () => {
  it("pytest -rA summary lines (FAILED ' - ' messages stripped)", () => {
    const log = [
      "PASSED tests/test_a.py::test_ok",
      "FAILED tests/test_a.py::test_bad - AssertionError: boom",
      "ERROR tests/test_a.py::test_err",
      "SKIPPED [1] tests/test_a.py:3: skip",
      "XFAIL tests/test_a.py::test_x - reason",
    ].join("\n");
    const m = parseLogPytest(log);
    assert.equal(m["tests/test_a.py::test_ok"], "PASSED");
    assert.equal(m["tests/test_a.py::test_bad"], "FAILED");
    assert.equal(m["tests/test_a.py::test_err"], "ERROR");
    assert.equal(m["tests/test_a.py::test_x"], "XFAIL");
  });

  it("pytest options parser normalises absolute path parameters (requests/pylint)", () => {
    const m = parseLogPytestOptions("PASSED tests/t.py::test_f[/abs/dir/file.txt]\nPASSED tests/t.py::test_g[a-b]");
    assert.equal(m["tests/t.py::test_f[/file.txt]"], "PASSED");
    assert.equal(m["tests/t.py::test_g[a-b]"], "PASSED");
  });

  it("django runner lines map 'name (module.Class)' to statuses", () => {
    const log = [
      "test_override_file_upload_permissions (test_utils.tests.OverrideSettingsTests) ... ok",
      "test_skip (test_utils.tests.SkippingTestCase) ... skipped 'no db'",
      "test_fail (test_utils.tests.X) ... FAIL",
      "test_err (test_utils.tests.X) ... ERROR",
      "test_multi (test_utils.tests.Y) ... some output",
      "ok",
    ].join("\n");
    const m = parseLogDjango(log);
    assert.equal(m["test_override_file_upload_permissions (test_utils.tests.OverrideSettingsTests)"], "PASSED");
    assert.equal(m["test_skip (test_utils.tests.SkippingTestCase)"], "SKIPPED");
    assert.equal(m["test_fail (test_utils.tests.X)"], "FAILED");
    assert.equal(m["test_err (test_utils.tests.X)"], "ERROR");
    assert.equal(m["test_multi (test_utils.tests.Y)"], "PASSED");
  });

  it("sympy bin/test verbose lines", () => {
    const m = parseLogSympy("test_ccode_Pow ok\ntest_ccode_sinc F\ntest_bad E\n________ sympy/printing/tests/test_ccode.py:test_ccode_sinc ________");
    assert.equal(m.test_ccode_Pow, "PASSED");
    assert.equal(m.test_ccode_sinc, "FAILED");
    assert.equal(m.test_bad, "ERROR");
    assert.equal(m["sympy/printing/tests/test_ccode.py:test_ccode_sinc"], "FAILED");
  });

  it("pytest v2 (astropy/sklearn/sphinx) strips ANSI and accepts trailing statuses", () => {
    const m = parseLogPytestV2("\u001b[32mPASSED\u001b[0m a.py::t1\na.py::t2 FAILED");
    assert.equal(m["a.py::t1"], "PASSED");
    assert.equal(m["a.py::t2"], "FAILED");
  });

  it("seaborn parser", () => {
    const m = parseLogSeaborn("tests/t.py::test_a PASSED [ 10%]\nFAILED tests/t.py::test_b - x");
    assert.equal(m["tests/t.py::test_a"], "PASSED");
    assert.equal(m["tests/t.py::test_b"], "FAILED");
  });

  it("every case-study repo has a parser", () => {
    for (const d of ["astropy/astropy", "django/django", "matplotlib/matplotlib", "mwaskom/seaborn", "pallets/flask", "psf/requests", "pydata/xarray", "pylint-dev/pylint", "pytest-dev/pytest", "scikit-learn/scikit-learn", "sphinx-doc/sphinx", "sympy/sympy"]) {
      assert.equal(typeof MAP_REPO_TO_PARSER[d], "function", d);
    }
  });
});

describe("SWE grading: directives, reports, test-file rules", () => {
  const patch = [
    "diff --git a/tests/test_utils/tests.py b/tests/test_utils/tests.py",
    "--- a/tests/test_utils/tests.py",
    "+++ b/tests/test_utils/tests.py",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "diff --git a/tests/new_case.py b/tests/new_case.py",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/tests/new_case.py",
    "@@ -0,0 +1 @@",
    "+x",
    "diff --git a/docs/data.json b/docs/data.json",
    "--- a/docs/data.json",
    "+++ b/docs/data.json",
    "@@ -1 +1 @@",
    "-1",
    "+2",
    "",
  ].join("\n");

  it("modified files exclude new files (upstream get_modified_files)", () => {
    assert.deepEqual(getModifiedFiles(patch), ["tests/test_utils/tests.py", "docs/data.json"]);
    assert.equal(splitPatchFiles(patch).length, 3);
  });

  it("django directives are dotted labels without tests/ prefix; non-test extensions dropped", () => {
    assert.deepEqual(getTestDirectives("django/django", patch), ["test_utils.tests", "new_case"]);
    assert.deepEqual(getTestDirectives("pallets/flask", patch), ["tests/test_utils/tests.py", "tests/new_case.py"]);
  });

  it("FAIL_TO_PASS / PASS_TO_PASS report and resolution status follow upstream", () => {
    const gold = { FAIL_TO_PASS: ["f1", "f2"], PASS_TO_PASS: ["p1", "p2"] };
    const full = getEvalTestsReport({ f1: "PASSED", f2: "XFAIL", p1: "PASSED", p2: "PASSED" }, gold);
    assert.equal(getResolutionStatus(full), "RESOLVED_FULL");
    const partial = getEvalTestsReport({ f1: "PASSED", f2: "FAILED", p1: "PASSED", p2: "PASSED" }, gold);
    assert.equal(getResolutionStatus(partial), "RESOLVED_PARTIAL");
    const missing = getEvalTestsReport({ f1: "PASSED", f2: "PASSED", p1: "PASSED" }, gold);
    assert.equal(getResolutionStatus(missing), "RESOLVED_NO", "a P2P test absent from the log counts as failed");
    const skipped = getEvalTestsReport({ f1: "PASSED", f2: "PASSED", p1: "PASSED", p2: "SKIPPED" }, gold);
    assert.equal(getResolutionStatus(skipped), "RESOLVED_FULL", "skipped tests are neither pass nor fail upstream");
  });

  it("log section between markers is parsed; no markers ⇒ unparseable", () => {
    const parser = parseLogPytest;
    const ok = parseEvalLog(">>>>> Start Test Output\nPASSED a::b\n>>>>> End Test Output\n", parser);
    assert.equal(ok.markers, true);
    assert.equal(ok.statusMap["a::b"], "PASSED");
    assert.equal(parseEvalLog("PASSED a::b", parser).markers, false);
  });

  it("test-file rule: test_patch files, tests/ dirs, test_*.py, conftest.py — not library 'testing' packages", () => {
    const tp = new Set(["lib/x/special.py"]);
    assert.equal(isTestPath("lib/x/special.py", tp), true);
    assert.equal(isTestPath("tests/test_utils/tests.py"), true);
    assert.equal(isTestPath("sympy/core/tests/test_basic.py"), true);
    assert.equal(isTestPath("testing/test_main.py"), true);
    assert.equal(isTestPath("conftest.py"), true);
    assert.equal(isTestPath("lib/matplotlib/testing/decorators.py"), false);
    assert.equal(isTestPath("django/conf/global_settings.py"), false);
  });

  it("FAIL_TO_PASS lists are JSON strings in task.yml", () => {
    assert.deepEqual(asTestList('["a (m.C)", "b"]'), ["a (m.C)", "b"]);
    assert.deepEqual(asTestList(["x"]), ["x"]);
  });
});

describe("SWE environments: recipe pieces", () => {
  it("cached upstream lockfiles: exact python, python libs as pip pins, system libs for bindings", () => {
    const yml = [
      "dependencies:",
      "  - python=3.10.15=h4a871b0_1_cpython",
      "  - numpy=1.23.0=py310h1794996_0",
      "  - cftime=1.6.4=py310hf462985_1",
      "  - eccodes=2.38.3=h8bb6dbc_1",
      "  - openssl=3.3.2=hb9d3cd8_0",
      "  - pip:",
      "      - pytest==7.4.0",
    ].join("\n");
    const s = splitEnvYml(yml, { pythonLibsAsPip: true });
    assert.equal(s.python, "3.10.15");
    assert.deepEqual(s.pip.sort(), ["cftime==1.6.4", "numpy==1.23.0", "pytest==7.4.0"]);
    assert.deepEqual(cachedSystemLibs(yml), ["eccodes=2.38.3"]);
  });

  it("every task resolves to a pinned upstream spec and its oracle patches verify", () => {
    for (const id of ["pallets__flask-4045", "django__django-10914", "sympy__sympy-11400", "scikit-learn__scikit-learn-10297"]) {
      const t = loadSweTask(join(tasksDir, id));
      assert.deepEqual(t.integrity_errors, [], id);
      const spec = specFor(t);
      assert.ok(spec.upstream.test_cmd, id);
      assert.ok(spec.deviations.length >= 1, id);
    }
  });
});

describe("SWE grader: validated environment on this host (integration)", () => {
  const record = loadEnvRecord("pallets__flask-4045");
  it("gold resolves, empty does not", { skip: !record?.ok ? "no validated flask env on this host (run selftest.mjs)" : false }, async () => {
    const { evaluatePatch } = await import("../world/eval.mjs");
    const task = loadSweTask(join(tasksDir, "pallets__flask-4045"));
    const gold = evaluatePatch(task, record, task.gold_patch, { label: "unit-gold" });
    assert.equal(gold.resolution, "RESOLVED_FULL");
    const empty = evaluatePatch(task, record, "", { label: "unit-empty" });
    assert.equal(empty.resolution, "RESOLVED_NO");
    assert.ok(existsSync(gold.log_path));
  });
});
