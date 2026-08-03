#!/usr/bin/env node
/**
 * Offline SWE pipeline smoke: seed worktree, apply oracle patch, grade with pytest.
 * Validates test pipeline fixes without a live KIT run.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applySeed, gradeSweBench, resolvePytestBinary } from "./case-study-backends.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const taskId = process.argv[2] ?? "django__django-10914";
const taskAbs = join(root, "case-studies/swe-bench/tasks", taskId);

function runNode(args) {
  return JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8" }));
}

const pytest = resolvePytestBinary();
assert.ok(pytest, "pytest binary must resolve");

const boot = runNode([
  join(root, "scripts/disposable-worktree.mjs"),
  "bootstrap",
  "--parent",
  root,
  "--tiny-seed",
  "false",
]);
const worktree = boot.worktree;
try {
  applySeed(worktree, taskAbs, root);
  const patch = readFileSync(join(taskAbs, "oracle/patch.diff"), "utf8");
  execFileSync("git", ["apply", "--whitespace=nowarn", "-"], {
    cwd: worktree,
    input: patch,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const grade = gradeSweBench(worktree, taskAbs);
  console.log(
    JSON.stringify(
      {
        task_id: taskId,
        ground_truth_pass: grade.ground_truth_pass,
        grade_exit_code: grade.grade_exit_code,
        grade_skipped: grade.details?.grade_skipped ?? false,
        skip_reason: grade.details?.skip_reason ?? null,
        diff_bytes: grade.diff?.length ?? 0,
      },
      null,
      2,
    ),
  );

  assert.equal(grade.details?.grade_skipped, false, "grading must not skip");
  assert.equal(typeof grade.grade_exit_code, "number", "numeric grade_exit_code");
  assert.ok(grade.diff && grade.diff.length > 0, "worktree.diff must be non-empty");
  if (!grade.ground_truth_pass) {
    console.error(
      `[warn] oracle patch did not pass FAIL_TO_PASS (exit=${grade.grade_exit_code}); pytest env may need task-specific setup`,
    );
  }
  console.error(`[ok] swe-pipeline-smoke ${taskId}`);
} finally {
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktree], {
      cwd: root,
      stdio: "pipe",
    });
  } catch {
    if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true });
  }
}
