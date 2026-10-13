/**
 * Path containment and scope checks for disposable-worktree local adapters.
 *
 * D7: tool paths and scopes are POSIX-normalized (backslashes → '/', './' and '//' and
 * trailing '/' stripped, '.' segments dropped) before segment-wise containment checks;
 * absolute paths, NUL, '..' and '.git' components are rejected; root scopes only as an
 * explicit grant ('.'). Every check runs on the normalized lexical path AND on the
 * resolved real path (relative to the real worktree root) so symlink aliases cannot
 * bypass scope / protected-path / secret / host-control checks.
 */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, posix, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";

export type SandboxPathErrorCode =
  | "path_escape"
  | "path_invalid"
  | "scope_denied"
  | "worktree_invalid"
  | "symlink_escape"
  | "host_reserved";

export class SandboxPathError extends Error {
  readonly code: SandboxPathErrorCode;
  constructor(code: SandboxPathErrorCode, message: string) {
    super(message);
    this.name = "SandboxPathError";
    this.code = code;
  }
}

/** Canonical root marker used for explicit whole-worktree grants. */
export const ROOT_SCOPE = ".";

const EXPLICIT_ROOT_SPELLINGS = new Set([".", "./", "*", "**"]);

/**
 * Normalize a tool-supplied relative path (D7). Returns "." for the worktree root.
 * Rejects empty, NUL, absolute/drive paths, any '..' component, and '.git' components.
 */
export function normalizeToolPath(rel: string): string {
  if (typeof rel !== "string" || rel.length === 0) {
    throw new SandboxPathError("path_invalid", "path must be a non-empty relative string");
  }
  if (rel.includes("\0")) {
    throw new SandboxPathError("path_invalid", "path contains NUL");
  }
  const unified = rel.replace(/\\/g, "/");
  if (isAbsolute(rel) || /^[a-zA-Z]:/.test(unified) || unified.startsWith("/")) {
    throw new SandboxPathError("path_escape", "absolute paths are forbidden");
  }
  const parts: string[] = [];
  for (const part of unified.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      throw new SandboxPathError("path_escape", "path traversal ('..') is forbidden");
    }
    if (part.toLowerCase() === ".git") {
      throw new SandboxPathError("path_escape", ".git paths are forbidden");
    }
    parts.push(part);
  }
  return parts.length ? parts.join("/") : ROOT_SCOPE;
}

/** @deprecated kept for callers; same as {@link normalizeToolPath}. */
export function assertSafeRelativePath(rel: string): string {
  return normalizeToolPath(rel);
}

/**
 * Normalize a declared scope (D7). '.', './', '*', '**' are explicit root grants.
 * Any other spelling that normalizes to the root (e.g. 'src/..', '') is rejected, as are
 * absolute scopes and scopes that escape via '..'. 'src' ≡ 'src/' ≡ './src//'.
 */
export function normalizeScope(raw: string): string {
  if (typeof raw !== "string") {
    throw new SandboxPathError("path_invalid", "scope must be a string");
  }
  const unified = raw.replace(/\\/g, "/").trim();
  if (EXPLICIT_ROOT_SPELLINGS.has(unified)) return ROOT_SCOPE;
  if (!unified || unified.includes("\0")) {
    throw new SandboxPathError("path_invalid", `invalid scope '${raw}'`);
  }
  if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified)) {
    throw new SandboxPathError("path_escape", `absolute scope '${raw}' is forbidden`);
  }
  const norm = posix.normalize(unified).replace(/\/+$/, "");
  if (norm === "" || norm === ".") {
    throw new SandboxPathError(
      "path_invalid",
      `scope '${raw}' resolves to the worktree root; grant root explicitly as '.'`,
    );
  }
  if (norm === ".." || norm.startsWith("../")) {
    throw new SandboxPathError("path_escape", `scope '${raw}' escapes the worktree`);
  }
  if (norm.split("/").some((p) => p.toLowerCase() === ".git")) {
    throw new SandboxPathError("path_escape", `scope '${raw}' targets .git`);
  }
  return norm;
}

export function normalizeScopes(raw: readonly string[]): string[] {
  return [...new Set(raw.map(normalizeScope))];
}

/** Normalize a declared path list entry (protected/secret paths) without the scope root rules. */
export function normalizeDeclaredPath(raw: string): string {
  return normalizeToolPath(String(raw));
}

/**
 * Segment-wise containment: `child` is covered when some scope is the root grant, equals
 * the child, or is a whole-segment prefix of it. Inputs are normalized first.
 */
export function scopeCovered(child: string, scopes: readonly string[]): boolean {
  let c: string;
  try {
    c = normalizeToolPath(child);
  } catch {
    return false;
  }
  return scopes.some((raw) => {
    let s: string;
    try {
      s = normalizeScope(raw);
    } catch {
      return false;
    }
    if (s === ROOT_SCOPE) return true;
    if (c === ROOT_SCOPE) return false;
    return c === s || c.startsWith(`${s}/`);
  });
}

/** True when `rel` (normalized) equals an entry or lies under a directory entry ending in '/'. */
export function pathListed(rel: string, entries: readonly string[]): boolean {
  return entries.some((e) => {
    if (e.endsWith("/")) {
      const dir = e.slice(0, -1);
      return rel === dir || rel.startsWith(e);
    }
    return rel === e;
  });
}

function withTrailingSep(p: string): string {
  return p.endsWith(sep) ? p : p + sep;
}

/**
 * Resolve a relative path under worktreeRoot and ensure the real path stays inside.
 * Checks every path component for symlink/junction escape. Returns the real path
 * (for not-yet-existing tails: the real parent joined with the lexical remainder).
 */
export function resolveContainedPath(worktreeRoot: string, relativePath: string): string {
  const safeRel = normalizeToolPath(relativePath);
  const rootReal = realpathSync.native(resolve(worktreeRoot));
  const rootPrefix = withTrailingSep(rootReal);
  if (safeRel === ROOT_SCOPE) return rootReal;
  let cur = rootReal;
  const parts = safeRel.split("/");
  for (let i = 0; i < parts.length; i++) {
    const next = join(cur, parts[i]!);
    if (!existsSync(next)) {
      let st: ReturnType<typeof lstatSync> | undefined;
      try {
        st = lstatSync(next);
      } catch {
        st = undefined;
      }
      if (st?.isSymbolicLink()) {
        // Dangling symlink: refuse (a write would follow it to an arbitrary target).
        throw new SandboxPathError("symlink_escape", "dangling symlink in path");
      }
      // Remaining path does not exist yet (writes): join lexically under the real parent.
      const candidate = normalize(join(cur, ...parts.slice(i)));
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

export type ResolvedAccess = {
  /** Normalized lexical path as requested ("." for root). */
  rel: string;
  /** Real absolute path (symlinks resolved; tail may not exist yet). */
  abs: string;
  /** Real path relative to the real worktree root, POSIX separators ("." for root). */
  realRel: string;
};

/** Resolve a tool path once and expose both the lexical and the real view (D7). */
export function resolveAccess(worktreeRoot: string, relativePath: string): ResolvedAccess {
  const rel = normalizeToolPath(relativePath);
  const abs = resolveContainedPath(worktreeRoot, rel);
  const rootReal = realpathSync.native(resolve(worktreeRoot));
  const r = relative(rootReal, abs).split(sep).join("/");
  const realRel = r === "" ? ROOT_SCOPE : r;
  if (realRel.split("/").some((p) => p.toLowerCase() === ".git")) {
    throw new SandboxPathError("path_escape", ".git paths are forbidden");
  }
  return { rel, abs, realRel };
}

/**
 * Scope check on the normalized lexical path AND the real path (EDGE-7): an in-worktree
 * symlink `src/link -> ../secrets` must not make `src/link/x` readable under scope `src/`.
 * `scopes` undefined means "unrestricted" (only valid for reads when the agent declares none).
 */
export function assertInScope(
  access: ResolvedAccess | string,
  scopes: readonly string[] | undefined,
  kind: "read" | "write",
): void {
  if (scopes === undefined) {
    if (kind === "read") return;
    throw new SandboxPathError("scope_denied", "no write scopes declared");
  }
  const rel = typeof access === "string" ? normalizeToolPath(access) : access.rel;
  const realRel = typeof access === "string" ? rel : access.realRel;
  if (scopes.length === 0 || !scopeCovered(rel, scopes) || !scopeCovered(realRel, scopes)) {
    throw new SandboxPathError("scope_denied", `${kind} scope denied`);
  }
}

export type WorktreeValidation = {
  root: string;
  isLinkedWorktree: boolean;
  /** Absolute git common dir (holds hooks/config shared with the primary checkout). */
  gitCommonDir?: string;
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
  const isLinked = gitAbs !== commonAbs && /\/worktrees\/[^/]+\/?$/.test(gitAbs);
  if (!isLinked) {
    throw new SandboxPathError(
      "worktree_invalid",
      "workspace must be a linked disposable git worktree (not the primary checkout)",
    );
  }

  return { root: rootReal, isLinkedWorktree: true, gitCommonDir: resolve(rootReal, commonDir) };
}
