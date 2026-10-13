/**
 * Isolated disposable workspaces for agent runs.
 *
 * The agent's workspace must contain ONLY the task seed (plus files the host
 * provisions explicitly). It is therefore never a linked worktree of the Fausth
 * repository (that would expose every task.yml / grade / oracle / gold file).
 *
 * Layout (one container per workspace, all under the workspace root):
 *
 *   <root>/ws-XXXXXX/
 *     .fausth-workspace.json   registry marker (outside the agent's workspace)
 *     repo/.git/               private repository: empty "init" commit + "seed" commit
 *     ws/                      linked worktree of repo/  ← the agent's --workspace
 *
 * The engine requires a *linked* git worktree; ws/ is one, but of the private
 * repo whose object store holds nothing except the seed.
 *
 * Cleanup only ever removes a container that carries a valid registry marker,
 * lives directly under the expected root and does not overlap the repository.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKSPACE_MARKER = ".fausth-workspace.json";
export const WORKSPACE_KIND = "fausth-disposable-workspace";
const CONTAINER_PREFIX = "ws-";

/** Repository root of this checkout (never a valid cleanup target). */
export const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));

/** Default root for disposable workspaces (outside the repository tree). */
export function defaultWorkspaceRoot() {
  return resolve(process.env.FAUSTH_WORKSPACE_ROOT || join(tmpdir(), "fausth-workspaces"));
}

/** Environment for private-repo git calls: no outer-repository overrides. */
function gitEnv() {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  for (const k of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ]) {
    delete env[k];
  }
  return env;
}

function git(cwd, args, opts = {}) {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=fausth-host",
      "-c",
      "user.email=fausth-host@localhost",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: gitEnv(),
      ...opts,
    },
  );
}

/** @param {string} parent @param {string} child */
export function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && rel !== "..");
}

/**
 * Seeds may not contain symlinks: copying them could point the workspace at
 * host files (graders, gold data) outside the seed.
 * @param {string} dir
 */
function assertNoSymlinks(dir) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const name of readdirSync(cur)) {
      const p = join(cur, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) {
        throw new Error(`seed contains a symlink (refusing to provision): ${p}`);
      }
      if (st.isDirectory()) stack.push(p);
    }
  }
}

/** Tiny default seed used by local e2e smoke runs. */
export function seedTinyRepo(dir) {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "app.js"),
    `export function add(a, b) {
  return a - b; // intentionally wrong — agent should fix to a + b
}
`,
  );
  writeFileSync(
    join(dir, "src", "app.test.js"),
    `import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { add } from "./app.js";

describe("add", () => {
  it("adds", () => {
    assert.equal(add(2, 3), 5);
  });
});
`,
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ type: "module", name: "fausth-e2e-seed" }, null, 2) + "\n",
  );
  writeFileSync(join(dir, "README.md"), "Disposable Fausth e2e workspace\n");
}

/**
 * Create an isolated workspace.
 * @param {{ seed?: string | null, tinySeed?: boolean, root?: string }} [opts]
 *   seed: directory copied into the workspace; tinySeed: built-in e2e seed;
 *   neither: empty workspace (for git_checkout seeders).
 * @returns {{ worktree: string, workspace_id: string, container: string, repo: string,
 *   root: string, base_commit: string, seed_kind: string, created_at: string, branch: null, parent: null }}
 */
export function bootstrapWorkspace(opts = {}) {
  const root = resolve(opts.root ?? defaultWorkspaceRoot());
  if (isInside(REPO_ROOT, root)) {
    throw new Error(`workspace root must be outside the repository: ${root}`);
  }
  mkdirSync(root, { recursive: true });
  const rootReal = realpathSync(root);
  const seed = opts.seed ? resolve(opts.seed) : null;
  if (seed) {
    if (!existsSync(seed) || !lstatSync(seed).isDirectory()) {
      throw new Error(`seed directory not found: ${seed}`);
    }
    assertNoSymlinks(seed);
  }

  const container = mkdtempSync(join(rootReal, CONTAINER_PREFIX));
  const repo = join(container, "repo");
  const ws = join(container, "ws");
  try {
    mkdirSync(repo);
    git(repo, ["init", "-q"]);
    git(repo, ["commit", "-q", "--allow-empty", "-m", "fausth: empty workspace"]);
    git(repo, ["worktree", "add", "-q", "--detach", ws, "HEAD"]);

    let seedKind = "empty";
    if (seed) {
      cpSync(seed, ws, { recursive: true, force: true, errorOnExist: false });
      seedKind = "dir";
    } else if (opts.tinySeed) {
      seedTinyRepo(ws);
      seedKind = "tiny";
    }
    if (seedKind !== "empty") {
      git(ws, ["add", "-A", "-f"]);
      git(ws, ["commit", "-q", "--allow-empty", "-m", "fausth: seed"]);
    }
    const baseCommit = git(ws, ["rev-parse", "HEAD"]).trim();
    const meta = {
      kind: WORKSPACE_KIND,
      version: 1,
      workspace_id: basename(container),
      worktree: ws,
      container,
      repo,
      root: rootReal,
      base_commit: baseCommit,
      seed_kind: seedKind,
      created_at: new Date().toISOString(),
      // Legacy fields kept for older callers of the bootstrap JSON.
      branch: null,
      parent: null,
    };
    writeFileSync(join(container, WORKSPACE_MARKER), JSON.stringify(meta, null, 2) + "\n");
    return meta;
  } catch (e) {
    rmSync(container, { recursive: true, force: true });
    throw e;
  }
}

/**
 * Check whether `worktree` is a registered workspace under `root`.
 * @param {string} worktree
 * @param {string} [root]
 * @returns {{ ok: boolean, reason?: string, container?: string, exists?: boolean }}
 */
export function checkRegisteredWorkspace(worktree, root = defaultWorkspaceRoot()) {
  if (!worktree || typeof worktree !== "string") {
    return { ok: false, reason: "--worktree is required" };
  }
  const abs = resolve(worktree);
  const rootAbs = resolve(root);
  let rootReal = rootAbs;
  try {
    rootReal = realpathSync(rootAbs);
  } catch {
    /* root missing: nothing can be registered under it */
  }
  let wsPath = abs;
  let exists = existsSync(abs);
  if (exists) {
    if (lstatSync(abs).isSymbolicLink()) {
      return { ok: false, reason: `refusing symlinked workspace path: ${abs}`, exists };
    }
    wsPath = realpathSync(abs);
  }
  const container = dirname(wsPath);
  if (basename(wsPath) !== "ws") {
    return { ok: false, reason: `not a disposable workspace path: ${abs}`, exists };
  }
  if (dirname(container) !== rootReal || !basename(container).startsWith(CONTAINER_PREFIX)) {
    return {
      ok: false,
      reason: `workspace is not directly under the expected root ${rootReal}: ${abs}`,
      exists,
    };
  }
  for (const guarded of [REPO_ROOT, process.cwd()]) {
    if (isInside(container, guarded) || isInside(guarded, container)) {
      return { ok: false, reason: `workspace overlaps a protected path (${guarded})`, exists };
    }
  }
  const markerPath = join(container, WORKSPACE_MARKER);
  if (!existsSync(markerPath)) {
    return { ok: false, reason: `no registry marker for ${abs}`, exists };
  }
  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    return { ok: false, reason: `unreadable registry marker for ${abs}`, exists };
  }
  if (marker?.kind !== WORKSPACE_KIND || resolve(String(marker.worktree ?? "")) !== wsPath) {
    return { ok: false, reason: `registry marker does not match ${abs}`, exists };
  }
  return { ok: true, container, exists };
}

/**
 * Remove a registered workspace (its whole container incl. the private repo).
 * Throws when the path is not a registered workspace under the expected root.
 * @param {{ worktree: string, root?: string }} opts
 */
export function cleanupWorkspace(opts) {
  const worktree = opts?.worktree;
  if (!worktree) throw new Error("--worktree is required");
  const root = opts.root ?? defaultWorkspaceRoot();
  const check = checkRegisteredWorkspace(worktree, root);
  if (!check.ok) {
    if (check.exists === false && check.reason?.startsWith("no registry marker")) {
      // Already gone (idempotent cleanup) — nothing to remove.
      return { cleaned: null, reason: "not_found" };
    }
    throw new Error(`refusing to remove: ${check.reason}`);
  }
  rmSync(check.container, { recursive: true, force: true });
  return { cleaned: resolve(worktree), container: check.container };
}
