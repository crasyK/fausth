/**
 * Agent patch capture for SWE worktrees seeded from a bare mirror.
 *
 * The diff is computed with a throw-away index and object directory, so the
 * shared mirror under live/cache/swe is only read, never written. Untracked
 * (new) files are included; Fausth metadata and Python build junk are not.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** Host-side directory next to the agent workspace (never inside it). */
export const HOST_DIR = ".fausth-swe";
/** Tooling paths inside the workspace that never count as part of the agent's patch. */
export const FAUSTH_DIR = ".fausth";
export const TARGETS_FILE_NAME = ".fausth-tests.txt";

/**
 * Host metadata for a seeded workspace lives OUTSIDE the agent's workspace:
 * `<parent>/.fausth-swe/<workspace basename>.json` (the disposable-workspace
 * container), so the agent never sees host paths (mirror, env root).
 */
export function seedMetaPath(worktree) {
  const abs = resolve(worktree);
  return join(dirname(abs), HOST_DIR, `${basename(abs)}.json`);
}

/** Launcher run by the deployment command `node ../.fausth-swe/run-tests.mjs`. */
export function launcherPath(worktree) {
  return join(dirname(resolve(worktree)), HOST_DIR, "run-tests.mjs");
}

const EXCLUDES = [
  ":(exclude).fausth-worktree.json",
  ":(exclude).fausth-swe-seed.json",
  `:(exclude)${FAUSTH_DIR}`,
  `:(exclude)${TARGETS_FILE_NAME}`,
  ":(exclude,glob)**/__pycache__/**",
  ":(exclude,glob)**/*.pyc",
  ":(exclude,glob)**/.pytest_cache/**",
  ":(exclude,glob)**/*.egg-info/**",
];

export function readSeedMeta(worktree) {
  const p = seedMetaPath(worktree);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Unified diff (with binary hunks) of `worktree` against `baseCommit` in `mirror`.
 * @returns {string}
 */
export function diffAgainstBase(mirror, baseCommit, worktree) {
  const scratch = mkdtempSync(join(tmpdir(), "fausth-swe-diff-"));
  mkdirSync(join(scratch, "objects", "pack"), { recursive: true });
  mkdirSync(join(scratch, "objects", "info"), { recursive: true });
  try {
    const env = {
      ...process.env,
      GIT_DIR: mirror,
      GIT_WORK_TREE: worktree,
      GIT_INDEX_FILE: join(scratch, "index"),
      GIT_OBJECT_DIRECTORY: join(scratch, "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(mirror, "objects"),
    };
    const git = (args) => {
      const r = spawnSync("git", args, { cwd: worktree, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout;
    };
    git(["read-tree", baseCommit]);
    git(["add", "-A", "--", ".", ...EXCLUDES]);
    return git(["diff", "--cached", "--binary", baseCommit, "--", ".", ...EXCLUDES]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
