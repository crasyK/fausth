/**
 * Unit tests for SWE grading helpers (pytest resolution + diff capture).
 */
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureSweWorktreeDiff,
  gradeSweBench,
  resolvePytestBinary,
} from "./case-study-backends.mjs";

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

  it("gradeSweBench returns numeric grade_exit_code when pytest exists", () => {
    const taskDir = mkdtempSync(join(tmpdir(), "fausth-swe-task-"));
    writeFileSync(
      join(taskDir, "task.yml"),
      "grade:\n  FAIL_TO_PASS: []\n  PASS_TO_PASS: []\n",
    );
    const grade = gradeSweBench(worktree, taskDir);
    assert.equal(grade.grade_kind, "swe_bench");
    assert.equal(grade.grade_skipped ?? grade.details?.grade_skipped, false);
    assert.notEqual(grade.grade_exit_code, null);
    assert.equal(typeof grade.grade_exit_code, "number");
    assert.ok(grade.diff.length > 0);
    rmSync(taskDir, { recursive: true, force: true });
  });
});
