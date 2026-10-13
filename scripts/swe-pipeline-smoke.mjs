#!/usr/bin/env node
/**
 * Offline SWE pipeline smoke: seed a disposable worktree from the mirror, apply the
 * oracle patch as if an agent wrote it, and grade it with the real grader (per-task
 * environment, gold test patch, repo-specific runner). Exits non-zero unless the
 * grade is a pass — or reports `grader_unavailable` explicitly (never a silent fail).
 *
 *   node scripts/swe-pipeline-smoke.mjs [instance_id]
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applySeed, gradeSweBench } from "./case-study-backends.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const taskId = process.argv[2] ?? "pallets__flask-4045";
const taskAbs = join(root, "case-studies/swe-bench/tasks", taskId);

const boot = JSON.parse(
  execFileSync(process.execPath, [join(root, "scripts/disposable-worktree.mjs"), "bootstrap", "--parent", root, "--tiny-seed", "false"], {
    encoding: "utf8",
  }),
);
const worktree = boot.worktree;
let exitCode = 0;
try {
  applySeed(worktree, taskAbs, root);
  const patch = readFileSync(join(taskAbs, "oracle/patch.diff"), "utf8");
  execFileSync("git", ["apply", "--whitespace=nowarn", "-"], { cwd: worktree, input: patch, stdio: ["pipe", "pipe", "pipe"] });
  const grade = gradeSweBench(worktree, taskAbs);
  console.log(
    JSON.stringify(
      {
        task_id: taskId,
        ground_truth_pass: grade.ground_truth_pass,
        grader_unavailable: grade.grader_unavailable ?? false,
        reason: grade.details?.unavailable_reason ?? null,
        resolution: grade.details?.resolution ?? null,
        test_tampering: grade.test_tampering,
        diff_bytes: grade.diff?.length ?? 0,
      },
      null,
      2,
    ),
  );
  if (grade.grader_unavailable) {
    console.error(`[unavailable] ${taskId}: ${grade.details?.unavailable_reason}`);
    exitCode = 3;
  } else {
    assert.equal(grade.ground_truth_pass, true, "oracle patch must pass the grader");
    assert.equal(grade.test_tampering, false);
    console.error(`[ok] swe-pipeline-smoke ${taskId}`);
  }
} finally {
  try {
    execFileSync(process.execPath, [join(root, "scripts/disposable-worktree.mjs"), "cleanup", "--parent", root, "--worktree", worktree], { stdio: "pipe" });
  } catch {
    if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true });
  }
}
process.exitCode = exitCode;
