/**
 * Run provenance (CASE-14): exact code state + runtime + inputs used by a run.
 *
 * A commit SHA alone does not identify the code that produced a result (dirty
 * trees, local edits). Provenance therefore records:
 *   - commit_sha, dirty flag, dirty paths, and a sha256 over the full working-tree
 *     diff against HEAD (tracked changes + untracked files)
 *   - per-file sha256 for every harness / deployment / task / grader / script file used
 *   - tree hashes for the engine sources
 *   - node / python / git versions
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".pytest_cache", ".venv", "dist"]);

/** @param {string | Buffer} data */
export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 512 * 1024 * 1024,
  });
}

/**
 * Commit + dirty state of the working tree at `root`.
 * @param {string} root
 * @returns {{ commit_sha: string | null, dirty: boolean | null, dirty_paths: string[], dirty_paths_truncated: boolean, diff_sha256: string | null, error?: string }}
 */
export function gitCodeState(root) {
  try {
    const commit = git(root, ["rev-parse", "HEAD"]).trim();
    const porcelain = git(root, ["status", "--porcelain=v1", "--untracked-files=all"])
      .split("\n")
      .filter(Boolean);
    const paths = porcelain.map((l) => l.slice(3));
    const dirty = paths.length > 0;
    let diffSha = null;
    if (dirty) {
      const h = createHash("sha256");
      h.update(git(root, ["diff", "HEAD", "--binary"]));
      const untracked = git(root, ["ls-files", "--others", "--exclude-standard"])
        .split("\n")
        .filter(Boolean)
        .sort();
      for (const rel of untracked) {
        const abs = join(root, rel);
        h.update(`\0untracked\0${rel}\0`);
        try {
          if (lstatSync(abs).isFile()) h.update(readFileSync(abs));
        } catch {
          /* vanished */
        }
      }
      diffSha = h.digest("hex");
    }
    return {
      commit_sha: commit,
      dirty,
      dirty_paths: paths.slice(0, 200),
      dirty_paths_truncated: paths.length > 200,
      diff_sha256: diffSha,
    };
  } catch (e) {
    return {
      commit_sha: null,
      dirty: null,
      dirty_paths: [],
      dirty_paths_truncated: false,
      diff_sha256: null,
      error: e instanceof Error ? e.message.slice(0, 300) : String(e),
    };
  }
}

/**
 * Expand files/dirs (relative to root) into sorted file paths.
 * @param {string} root
 * @param {string[]} relPaths
 */
export function expandFiles(root, relPaths) {
  /** @type {Set<string>} */
  const out = new Set();
  const walk = (abs) => {
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(abs)) {
        if (SKIP_DIRS.has(name)) continue;
        walk(join(abs, name));
      }
    } else if (st.isFile()) {
      out.add(relative(root, abs).split(sep).join("/"));
    }
  };
  for (const rel of relPaths) {
    if (!rel) continue;
    walk(resolve(root, rel));
  }
  return [...out].sort();
}

/**
 * Per-file sha256 for the given files/dirs (relative to root).
 * @param {string} root
 * @param {string[]} relPaths
 * @returns {Record<string, string>}
 */
export function hashFiles(root, relPaths) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const rel of expandFiles(root, relPaths)) {
    out[rel] = sha256(readFileSync(join(root, rel)));
  }
  return out;
}

/**
 * Single digest over every file under `relDir` (path + content).
 * @param {string} root
 * @param {string} relDir
 */
export function hashTree(root, relDir) {
  const files = expandFiles(root, [relDir]);
  if (!files.length) return null;
  const h = createHash("sha256");
  for (const rel of files) {
    h.update(rel);
    h.update("\0");
    h.update(sha256(readFileSync(join(root, rel))));
    h.update("\n");
  }
  return h.digest("hex");
}

/**
 * Interpreter / tool versions that can change results.
 * @param {string} root
 */
export function runtimeVersions(root) {
  const tryRun = (cmd, args) => {
    try {
      return execFileSync(cmd, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      })
        .trim()
        .split("\n")[0];
    } catch {
      return null;
    }
  };
  const venvPy = join(root, ".venv", "bin", "python");
  const py = existsSync(venvPy) ? venvPy : "python3";
  // Where the Python engine is imported from: an editable install pointing at
  // another checkout would silently run different engine code.
  const pyEngine = tryRun(py, ["-c", "import fausth; print(fausth.__file__)"]);
  return {
    node: process.version,
    python: tryRun(py, ["--version"]),
    python_engine_path: pyEngine,
    python_engine_in_repo: pyEngine ? resolve(pyEngine).startsWith(resolve(root) + sep) : null,
    git: tryRun("git", ["--version"]),
    platform: `${process.platform}-${process.arch}`,
  };
}

/**
 * Decide whether a run may start and whether it counts as evidence.
 * Live runs are evidence (promotable) only on a clean tree; a dirty tree is
 * refused unless explicitly allowed, and then marked non-evidence.
 * @param {{ mode: string, dirty: boolean | null, allowDirty?: boolean, smoke?: boolean }} opts
 * @returns {{ ok: boolean, evidence: boolean, reason: string }}
 */
export function evidenceGate(opts) {
  if (opts.mode !== "live") {
    return { ok: true, evidence: false, reason: "recorded traces are plumbing regression, not evidence" };
  }
  if (opts.dirty === null) {
    return opts.allowDirty
      ? { ok: true, evidence: false, reason: "code state unknown (allowed by --allow-dirty)" }
      : { ok: false, evidence: false, reason: "cannot determine git code state; pass --allow-dirty to run anyway" };
  }
  if (opts.dirty) {
    return opts.allowDirty
      ? { ok: true, evidence: false, reason: "dirty working tree (allowed by --allow-dirty)" }
      : {
          ok: false,
          evidence: false,
          reason: "refusing a live (evidence) run on a dirty working tree; commit first or pass --allow-dirty",
        };
  }
  if (opts.smoke) return { ok: true, evidence: false, reason: "live smoke run (--smoke)" };
  return { ok: true, evidence: true, reason: "live run on a clean tree" };
}
