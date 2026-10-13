/**
 * Filesystem scope normalization and containment (spec-v0.3 §4.2, D7).
 *
 * One definition for the engine (spawn tighten-only checks, validation) and the host world
 * adapters: normalization is delegated to the adapters' sandbox-path rules so that every host
 * interprets `permissions.filesystem` exactly as the engine does. On top of that, authoring
 * rejects `*` outside the explicit root spellings (scopes are paths, not globs).
 */
import { normalizeScope as normalizeHostScope, ROOT_SCOPE, SandboxPathError } from "./adapters/sandbox-path.js";

/** Normalized scope: `{ root: true }` or the POSIX segments of a relative path. */
export type Scope = { root: true } | { root: false; segments: string[] };

export type ScopeParse = { ok: true; scope: Scope } | { ok: false; problem: ScopeProblem };

export type ScopeProblem = "invalid" | "absolute" | "escape" | "implicit_root" | "git" | "glob";

const ROOT_FORMS = new Set([".", "./", "*", "**"]);

function problemOf(e: unknown, raw: string): ScopeProblem {
  if (!(e instanceof SandboxPathError)) return "invalid";
  const unified = raw.replace(/\\/g, "/").trim();
  if (e.code === "path_escape") {
    if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified)) return "absolute";
    if (unified.split("/").some((p) => p.toLowerCase() === ".git")) return "git";
    return "escape";
  }
  if (/resolves to the worktree root/.test(e.message)) return "implicit_root";
  return "invalid";
}

/** Normalize one scope string. Root is granted only by `.`, `./`, `*`, `**`. */
export function parseScope(raw: string): ScopeParse {
  if (typeof raw !== "string") return { ok: false, problem: "invalid" };
  const unified = raw.replace(/\\/g, "/").trim();
  if (!ROOT_FORMS.has(unified) && unified.includes("*")) return { ok: false, problem: "glob" };
  let norm: string;
  try {
    norm = normalizeHostScope(raw);
  } catch (e) {
    return { ok: false, problem: problemOf(e, raw) };
  }
  if (norm === ROOT_SCOPE) return { ok: true, scope: { root: true } };
  return { ok: true, scope: { root: false, segments: norm.split("/") } };
}

/** Canonical text of a scope (`.` for root, else `a/b`). */
export function scopeText(scope: Scope): string {
  return scope.root ? ROOT_SCOPE : scope.segments.join("/");
}

/** Normalize to text, or null when invalid. */
export function normalizeScope(raw: string): string | null {
  const r = parseScope(raw);
  return r.ok ? scopeText(r.scope) : null;
}

/** Segment-wise containment: does `parent` cover `child`? Root is covered only by root. */
export function scopeContains(parent: Scope, child: Scope): boolean {
  if (parent.root) return true;
  if (child.root) return false;
  if (parent.segments.length > child.segments.length) return false;
  return parent.segments.every((s, i) => child.segments[i] === s);
}

/** True iff `child` (raw) is valid and covered by at least one valid raw parent scope. */
export function scopeCoveredBy(child: string, parents: readonly string[]): boolean {
  const c = parseScope(child);
  if (!c.ok) return false;
  return parents.some((p) => {
    const ps = parseScope(p);
    return ps.ok && scopeContains(ps.scope, c.scope);
  });
}
