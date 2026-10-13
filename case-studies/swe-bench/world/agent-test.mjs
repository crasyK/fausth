#!/usr/bin/env node
/**
 * Agent-side test command for SWE tasks (deployment `world.commands.tests` =
 * `node ../.fausth-swe/run-tests.mjs`: a host-written launcher next to — never
 * inside — the agent workspace; cwd = agent worktree).
 *
 * Runs the repo's upstream test command (the same one the grader uses: pytest
 * node ids, Django `tests/runtests.py` dotted labels, SymPy `bin/test` paths,
 * Sphinx tox) on the targets the agent lists in `.fausth/tests.txt`, inside the
 * task's prebuilt environment with the agent's current edits applied. The gold
 * test patch is never applied here (no grading information reaches the agent).
 *
 * Exit code = the test command's exit code (2: no targets, 3: environment
 * unavailable). Output is the test log.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMPILED_REPOS,
  condaEnv,
  envDirFor,
  envRoot,
  loadEnvRecord,
  loadSweTask,
  loadUpstreamSpecs,
  mirrorPath,
  REPO_ROOT,
  runBash,
  withDirLock,
} from "./env.mjs";
import { applyPatchSnippet } from "./eval.mjs";
import { splitPatchFiles } from "./grading.mjs";
import { diffAgainstBase, FAUSTH_DIR, readSeedMeta } from "./patch.mjs";

export const TARGETS_FILE = `${FAUSTH_DIR}/tests.txt`;

function q(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function readTargets(worktree) {
  const p = join(worktree, TARGETS_FILE);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .filter((l) => /^[A-Za-z0-9_./:\-\[\]=,]+$/.test(l)); // targets only, no shell syntax
}

export function runAgentTests(worktree, { timeoutMs = 840_000 } = {}) {
  const meta = readSeedMeta(worktree);
  if (!meta?.instance_id) {
    return { code: 3, output: "test environment unavailable: workspace has no SWE seed metadata" };
  }
  const targets = readTargets(worktree);
  if (!targets.length) {
    return {
      code: 2,
      output:
        `no test targets: write one target per line to ${TARGETS_FILE} ` +
        "(pytest node ids or test files; Django: dotted labels like 'test_utils.tests'; SymPy: test file paths), then run cmd=tests again",
    };
  }
  const task = loadSweTask(join(REPO_ROOT, "case-studies", "swe-bench", "tasks", meta.instance_id));
  const record = loadEnvRecord(task.id);
  if (!record?.ok) {
    return { code: 3, output: `test environment unavailable for ${task.id} (build it with case-studies/swe-bench/world/selftest.mjs)` };
  }
  const upstream = loadUpstreamSpecs().specs[task.repo][task.version];
  const patch = diffAgainstBase(mirrorPath(task.repo), task.base_commit, worktree);
  const evalDir = join(envDirFor(task.id), "agent-tests");
  mkdirSync(evalDir, { recursive: true });
  const patchFile = join(evalDir, `${Date.now()}-${process.pid}.diff`);
  writeFileSync(patchFile, patch);
  const touchesBuild = splitPatchFiles(patch).some((s) => !/\.py$/.test(String(s.bPath ?? s.aPath ?? "")));
  const reinstall = COMPILED_REPOS.has(task.repo) && touchesBuild && upstream.install;
  const reset = `git reset -q --hard ${q(record.env_head)} && git clean -fdq`;
  const script = [
    "set -u",
    `cd ${q(record.testbed)}`,
    `${reset} || { echo "testbed reset failed"; exit 3; }`,
    patch.trim() ? applyPatchSnippet(record, patchFile) : ":",
    ...(upstream.eval_commands ?? []).filter((l) => /^export\s/.test(l)),
    reinstall ? upstream.install : ":",
    [upstream.test_cmd, ...targets.map(q)].join(" "),
    "rc=$?",
    reset,
    "exit $rc",
  ].join("\n");
  const r = withDirLock(join(envRoot(), ".locks", `${task.id}.testbed`), timeoutMs + 600_000, () =>
    runBash(script, {
      cwd: record.testbed,
      env: condaEnv(record, { HOME: join(envDirFor(task.id), "home"), MPLBACKEND: "Agg" }),
      timeoutMs,
    }),
  );
  if (r.timedOut) {
    runBash(`cd ${q(record.testbed)} && ${reset}`, { env: condaEnv(record) });
  }
  return { code: r.timedOut ? 124 : r.code, output: r.output };
}

export function main(worktree = process.cwd()) {
  const r = runAgentTests(worktree);
  process.stdout.write(r.output.endsWith("\n") ? r.output : `${r.output}\n`);
  return r.code;
}
