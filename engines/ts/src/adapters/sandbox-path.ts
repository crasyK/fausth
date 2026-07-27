/**
 * Path containment and scope checks for disposable-worktree local adapters.
 * Reject traversal, absolute tool paths, NUL, .git, and escaping symlinks/junctions.
 */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";

export class SandboxPathError extends Error {
  readonly code:
    | "path_escape"
    | "path_invalid"
    | "scope_denied"
    | "worktree_invalid"
    | "symlink_escape";
  constructor(
    code: SandboxPathError["code"],
    message: string,
  ) {
    super(message);
    this.name = "SandboxPathError";
    this.code = code;
  }
}

export function scopeCovered(child: string, parents: string[]): boolean {
  const c = child.replace(/\\/g, "/");
  return parents.some((p) => {
    const parent = p.replace(/\\/g, "/");
    if (c === parent) return true;
    const prefix = parent.endsWith("/") ? parent : parent + "/";
    return c.startsWith(prefix) || c === parent.replace(/\/$/, "");
  });
}

/** Reject absolute paths, NUL, `..`, empty, and `.git` components in tool-supplied relative paths. */
export function assertSafeRelativePath(rel: string): string {
  if (typeof rel !== "string" || !rel) {
    throw new SandboxPathError("path_invalid", "path must be a non-empty relative string");
  }
  if (rel.includes("\0")) {
    throw new SandboxPathError("path_invalid", "path contains NUL");
  }
  const unified = rel.replace(/\\/g, "/");
  if (isAbsolute(rel) || /^[a-zA-Z]:/.test(unified) || unified.startsWith("/")) {
    throw new SandboxPathError("path_escape", "absolute paths are forbidden");
  }
  const parts = unified.split("/").filter((p) => p.length > 0);
  for (const part of parts) {
    if (part === "..") {
      throw new SandboxPathError("path_escape", "path traversal ('..') is forbidden");
    }
    if (part === ".git" || part.toLowerCase() === ".git") {
      throw new SandboxPathError("path_escape", ".git paths are forbidden");
    }
  }
  return parts.join("/");
}

function withTrailingSep(p: string): string {
  return p.endsWith(sep) ? p : p + sep;
}

/**
 * Resolve a relative path under worktreeRoot and ensure the real path stays inside.
 * Checks every path component for symlink/junction escape.
 */
export function resolveContainedPath(worktreeRoot: string, relativePath: string): string {
  const safeRel = assertSafeRelativePath(relativePath);
  const rootReal = realpathSync.native(resolve(worktreeRoot));
  const rootPrefix = withTrailingSep(rootReal);
  let cur = rootReal;
  const parts = safeRel.split("/").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const next = join(cur, parts[i]!);
    if (!existsSync(next)) {
      // Remaining path does not exist yet (writes); ensure join stays lexical under root.
      const candidate = normalize(join(rootReal, ...parts));
      if (candidate !== rootReal && !candidate.startsWith(rootPrefix)) {
        throw new SandboxPathError("path_escape", "resolved path escapes worktree");
      }
      return candidate;
    }
    const st = lstatSync(next);
    if (st.isSymbolicLink()) {
      const real = realpathSync.native(next);
      if (real !== rootReal && !real.startsWith(rootPrefix)) {
        throw new SandboxPathError("symlink_escape", "symlink/junction escapes worktree");
      }
      cur = real;
    } else {
      cur = next;
    }
  }
  const finalReal = existsSync(cur) ? realpathSync.native(cur) : cur;
  if (finalReal !== rootReal && !finalReal.startsWith(rootPrefix)) {
    throw new SandboxPathError("path_escape", "resolved path escapes worktree");
  }
  return finalReal;
}

export function assertInScope(relPath: string, scopes: string[] | undefined, kind: "read" | "write"): void {
  if (!scopes || scopes.length === 0) {
    if (kind === "read") return; // no read scopes declared → allow within worktree
    throw new SandboxPathError("scope_denied", "no write scopes declared");
  }
  const unified = relPath.replace(/\\/g, "/");
  if (!scopeCovered(unified, scopes)) {
    throw new SandboxPathError("scope_denied", `${kind} scope denied for '${relPath}'`);
  }
}

export type WorktreeValidation = {
  root: string;
  isLinkedWorktree: boolean;
};

/**
 * Validate that workspace is an absolute path to a linked git worktree (not the primary checkout).
 */
export function validateLinkedWorktree(workspace: string): WorktreeValidation {
  if (!workspace || typeof workspace !== "string") {
    throw new SandboxPathError("worktree_invalid", "workspace is required");
  }
  if (workspace.includes("\0")) {
    throw new SandboxPathError("worktree_invalid", "workspace contains NUL");
  }
  const abs = resolve(workspace);
  if (!existsSync(abs)) {
    throw new SandboxPathError("worktree_invalid", `workspace does not exist: ${abs}`);
  }
  let rootReal: string;
  try {
    rootReal = realpathSync.native(abs);
  } catch {
    throw new SandboxPathError("worktree_invalid", `cannot resolve workspace: ${abs}`);
  }

  let porcelain: string;
  try {
    porcelain = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: rootReal,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    }).trim();
  } catch {
    throw new SandboxPathError("worktree_invalid", "workspace is not a git worktree");
  }
  if (porcelain !== "true") {
    throw new SandboxPathError("worktree_invalid", "workspace is not a git worktree");
  }

  let commonDir: string;
  let gitDir: string;
  try {
    commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: rootReal,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    })
      .trim()
      .replace(/\\/g, "/");
    gitDir = execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: rootReal,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    })
      .trim()
      .replace(/\\/g, "/");
  } catch {
    throw new SandboxPathError("worktree_invalid", "cannot inspect git directories");
  }

  // Linked worktrees use <common>/.git/worktrees/<name> while primary uses <common>/.git (== git-dir).
  const commonAbs = resolve(rootReal, commonDir).replace(/\\/g, "/");
  const gitAbs = resolve(rootReal, gitDir).replace(/\\/g, "/");
  const isLinked =
    gitAbs !== commonAbs &&
    (gitAbs.includes("/worktrees/") || gitAbs.includes("\\worktrees\\") || /\/worktrees\//.test(gitAbs));

  if (!isLinked) {
    // Also accept: git-dir path contains "worktrees"
    const linkedAlt = /worktrees[/\\][^/\\]+$/i.test(gitAbs);
    if (!linkedAlt) {
      throw new SandboxPathError(
        "worktree_invalid",
        "workspace must be a linked disposable git worktree (not the primary checkout)",
      );
    }
  }

  return { root: rootReal, isLinkedWorktree: true };
}
