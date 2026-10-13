/**
 * Unit tests for case-study seed/grade backends (SWE + τ graders).
 *   node --test scripts/case-study-backends.test.mjs
 */
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applySeed,
  captureSweWorktreeDiff,
  gradeSweBench,
  gradeTask,
  outputFound,
  resolvePytestBinary,
  splitAgentPatch,
  userFacingMessages,
} from "./case-study-backends.mjs";
import { loadEnvRecord } from "../case-studies/swe-bench/world/env.mjs";
import { loadSelftest } from "../case-studies/swe-bench/world/selftest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function initGitWorktree(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "fausth@test"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "fausth"], { cwd: dir, stdio: "pipe" });
}

describe("case-study-backends SWE helpers", () => {
  let worktree = "";

  before(() => {
    worktree = mkdtempSync(join(tmpdir(), "fausth-swe-grade-"));
    initGitWorktree(worktree);
    writeFileSync(join(worktree, "module.py"), "x = 1\n");
  });

  after(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  it("resolvePytestBinary finds venv or runner", () => {
    const pytest = resolvePytestBinary();
    assert.ok(pytest, "expected pytest binary");
    assert.ok(existsSync(pytest) || pytest.endsWith("pytest-runner.sh"));
  });

  it("captureSweWorktreeDiff includes untracked edits", () => {
    writeFileSync(join(worktree, "patched.py"), "y = 2\n");
    const diff = captureSweWorktreeDiff(worktree);
    assert.match(diff, /patched\.py/);
    assert.match(diff, /\+y = 2/);
  });

  it("gradeSweBench never reports a model failure when it cannot grade (grader_unavailable)", () => {
    const taskDir = mkdtempSync(join(tmpdir(), "fausth-swe-task-"));
    writeFileSync(join(taskDir, "task.yml"), "grade:\n  kind: swe_bench\n  FAIL_TO_PASS: []\n  PASS_TO_PASS: []\n");
    const grade = gradeSweBench(worktree, taskDir, { autobuild: false });
    assert.equal(grade.grade_kind, "swe_bench");
    assert.equal(grade.grader_unavailable, true);
    assert.equal(grade.ground_truth_pass, null);
    assert.equal(grade.details.grader_unavailable, true);
    assert.ok(grade.details.unavailable_reason);
    rmSync(taskDir, { recursive: true, force: true });
  });

  it("splitAgentPatch keeps tests out of the graded patch and reports tampering", () => {
    const diff = [
      "diff --git a/src/lib.py b/src/lib.py",
      "--- a/src/lib.py",
      "+++ b/src/lib.py",
      "@@ -1 +1 @@",
      "-a = 1",
      "+a = 2",
      "diff --git a/tests/test_lib.py b/tests/test_lib.py",
      "--- a/tests/test_lib.py",
      "+++ b/tests/test_lib.py",
      "@@ -1 +1 @@",
      "-assert a == 2",
      "+assert True",
      "diff --git a/tests/test_new.py b/tests/test_new.py",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/tests/test_new.py",
      "@@ -0,0 +1 @@",
      "+def test_x(): pass",
      "",
    ].join("\n");
    const s = splitAgentPatch(diff, "");
    assert.match(s.sourcePatch, /src\/lib\.py/);
    assert.doesNotMatch(s.sourcePatch, /tests\//);
    assert.equal(s.tampering, true, "editing an existing test is tampering");
    assert.deepEqual(
      s.testFiles.map((f) => [f.path, f.status, f.tampering]),
      [
        ["tests/test_lib.py", "modified", true],
        ["tests/test_new.py", "added", false],
      ],
    );
    const onlyNew = splitAgentPatch(diff.split("diff --git a/tests/test_lib.py")[0] + "diff --git a/tests/test_new.py" + diff.split("diff --git a/tests/test_new.py")[1], "");
    assert.equal(onlyNew.tampering, false, "adding a new regression test is not tampering");
  });

  const mirror = join(repoRoot, "live/cache/swe/pallets__flask.git");
  const flaskTask = join(repoRoot, "case-studies/swe-bench/tasks/pallets__flask-4045");

  it("git_checkout seed + diff: mirror is read-only, new files included, metadata excluded", { skip: !existsSync(mirror) ? "no flask mirror" : false }, () => {
    const wt = mkdtempSync(join(tmpdir(), "fausth-swe-seed-"));
    const head = existsSync(join(mirror, "index")) ? readFileSync(join(mirror, "index")) : null;
    try {
      applySeed(wt, flaskTask, repoRoot);
      assert.ok(existsSync(join(wt, "src/flask/blueprints.py")));
      assert.equal(existsSync(join(wt, ".fausth-swe-seed.json")), false, "no host metadata inside the workspace");
      assert.equal(existsSync(join(wt, ".fausth")), false, "no host launcher inside the workspace");
      assert.ok(existsSync(join(dirname(wt), ".fausth-swe/run-tests.mjs")), "launcher next to the workspace");
      const meta = JSON.parse(readFileSync(join(dirname(wt), ".fausth-swe", `${basename(wt)}.json`), "utf8"));
      assert.equal(meta.instance_id, "pallets__flask-4045");
      mkdirSync(join(wt, ".fausth"), { recursive: true });
      assert.equal(captureSweWorktreeDiff(wt), "", "fresh seed has an empty diff");
      writeFileSync(join(wt, "src/flask/new_module.py"), "X = 1\n");
      writeFileSync(join(wt, ".fausth/tests.txt"), "tests/test_basic.py\n");
      const diff = captureSweWorktreeDiff(wt);
      assert.match(diff, /new_module\.py/);
      assert.doesNotMatch(diff, /\.fausth/);
      const after = existsSync(join(mirror, "index")) ? readFileSync(join(mirror, "index")) : null;
      assert.deepEqual(after, head, "mirror index untouched");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  const rec = loadEnvRecord("pallets__flask-4045");
  const validated = rec?.ok && loadSelftest(rec)?.ok;
  it("gradeSweBench end-to-end: gold passes, test tampering cannot buy a pass", { skip: !validated ? "flask env not validated on this host" : false }, () => {
    const wt = mkdtempSync(join(tmpdir(), "fausth-swe-e2e-"));
    try {
      applySeed(wt, flaskTask, repoRoot);
      const gold = readFileSync(join(flaskTask, "oracle/patch.diff"), "utf8");
      execFileSync("git", ["apply", "-"], { cwd: wt, input: gold });
      const ok = gradeSweBench(wt, flaskTask, { autobuild: false });
      assert.equal(ok.grader_unavailable, undefined);
      assert.equal(ok.ground_truth_pass, true);
      assert.equal(ok.test_tampering, false);
      // reset and instead weaken the tests: still not resolved, tampering reported
      rmSync(wt, { recursive: true, force: true });
      mkdirSync(wt);
      applySeed(wt, flaskTask, repoRoot);
      writeFileSync(join(wt, "tests/test_blueprints.py"), "def test_dotted_name_not_allowed():\n    pass\n");
      const cheat = gradeSweBench(wt, flaskTask, { autobuild: false });
      assert.equal(cheat.ground_truth_pass, false);
      assert.equal(cheat.test_tampering, true);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe("SWE agent test command (deployment cmd=tests)", () => {
  const flaskTask = join(repoRoot, "case-studies/swe-bench/tasks/pallets__flask-4045");
  const rec = loadEnvRecord("pallets__flask-4045");
  it("runs the repo's test runner on the agent's targets in the task env; no targets ⇒ exit 2", { skip: !rec?.ok ? "flask env not built on this host" : false }, () => {
    const wt = mkdtempSync(join(tmpdir(), "fausth-swe-agenttest-"));
    try {
      applySeed(wt, flaskTask, repoRoot);
      // exactly the deployment argv, with an engine-like scrubbed env and private HOME
      const childEnv = { PATH: process.env.PATH, HOME: mkdtempSync(join(tmpdir(), "fausth-private-home-")) };
      const run = () => {
        try {
          return { code: 0, out: execFileSync("node", ["../.fausth-swe/run-tests.mjs"], { cwd: wt, encoding: "utf8", env: childEnv }) };
        } catch (e) {
          return { code: e.status, out: String(e.stdout) };
        }
      };
      mkdirSync(join(wt, ".fausth"), { recursive: true });
      const none = run();
      assert.equal(none.code, 2);
      assert.match(none.out, /no test targets/);
      writeFileSync(join(wt, ".fausth/tests.txt"), "tests/test_blueprints.py::test_add_template_filter\n");
      const ok = run();
      assert.equal(ok.code, 0, ok.out.slice(-800));
      assert.match(ok.out, /PASSED tests\/test_blueprints\.py::test_add_template_filter/);
      // the agent's own edit is what gets tested (break the module → failure)
      writeFileSync(join(wt, "src/flask/blueprints.py"), "raise ImportError('broken by agent')\n");
      const broken = run();
      assert.notEqual(broken.code, 0);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe("case-study-backends τ helpers", () => {
  it("user-facing messages come only from executed user-channel calls", () => {
    const events = [
      { stage: "propose", tool: "user.ask", args: { message: "draft 1093.34" } },
      { stage: "execute", verdict: "allow", tool: "tau.invoke", args: { tool: "calculate" }, result: { result: "1093.34" } },
      { stage: "execute", verdict: "allow", tool: "user.ask", args: { message: "Your refund is 1,093.34 dollars" }, result: { answer: "ok" } },
      { stage: "execute", verdict: "deny", tool: "user.ask", args: { message: "denied 746342064230" } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    const msgs = userFacingMessages(events);
    assert.deepEqual(msgs, ["Your refund is 1,093.34 dollars"]);
    assert.equal(outputFound("1093.34", msgs), true, "commas removed, case-insensitive (upstream)");
    assert.equal(outputFound("746342064230", msgs), false, "tool outputs and denied messages do not count");
  });

  it("gradeTask dispatches node_heldout by default", () => {
    const taskDir = mkdtempSync(join(tmpdir(), "fausth-node-task-"));
    const wt = mkdtempSync(join(tmpdir(), "fausth-node-wt-"));
    try {
      writeFileSync(join(taskDir, "task.yml"), "id: t\n");
      const g = gradeTask(wt, taskDir, "");
      assert.equal(g.grade_kind, "node_heldout");
    } finally {
      rmSync(taskDir, { recursive: true, force: true });
      rmSync(wt, { recursive: true, force: true });
    }
  });

  void cpSync;
});
