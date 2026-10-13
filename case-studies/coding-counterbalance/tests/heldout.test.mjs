/**
 * Held-out graders are genuinely held out and self-tested (CASE-18):
 *   - grade/app.grade.test.js is not a copy of the visible seed test and adds ≥2 new cases;
 *   - the reference solution (tasks/<id>/reference/, never seeded) passes it;
 *   - the unmodified seed fails it.
 *   node --test case-studies/coding-counterbalance/tests/heldout.test.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tasksDir = join(here, "..", "tasks");
const tasks = readdirSync(tasksDir).filter((d) => existsSync(join(tasksDir, d, "grade", "app.grade.test.js"))).sort();

function runGrade(taskId, withReference) {
  const ws = mkdtempSync(join(tmpdir(), `cc-heldout-${taskId}-`));
  try {
    cpSync(join(tasksDir, taskId, "seed"), ws, { recursive: true });
    if (withReference) cpSync(join(tasksDir, taskId, "reference"), ws, { recursive: true });
    cpSync(join(tasksDir, taskId, "grade"), join(ws, "grade"), { recursive: true });
    // a nested `node --test` inherits NODE_TEST_CONTEXT and would report to this runner
    // instead of exiting non-zero; grade exactly as the case-study grader does (clean env).
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ["--test", "grade/app.grade.test.js"], { cwd: ws, encoding: "utf8", env });
    return r.status;
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

const assertions = (src) =>
  src
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("assert."));

describe("coding-counterbalance held-out graders", () => {
  it("cover all 8 tasks", () => assert.equal(tasks.length, 8));
  for (const id of tasks) {
    it(`${id}: held-out ≠ visible, reference passes, seed fails`, () => {
      const visible = readFileSync(join(tasksDir, id, "seed", "src", "app.test.js"), "utf8");
      const heldout = readFileSync(join(tasksDir, id, "grade", "app.grade.test.js"), "utf8");
      const novel = assertions(heldout).filter((a) => !assertions(visible).includes(a));
      assert.ok(novel.length >= 2, `held-out test must add new cases (novel assertions: ${novel.length})`);
      assert.notEqual(heldout.replace(/\.\.\/src\//g, "./"), visible, "not a copy of the visible test");
      assert.equal(existsSync(join(tasksDir, id, "seed", "reference")), false, "reference never seeded");
      assert.equal(runGrade(id, true), 0, "reference solution must pass the held-out test");
      assert.notEqual(runGrade(id, false), 0, "unmodified seed must fail the held-out test");
    });
  }
});
