/**
 * Filesystem scope normalization and containment (spec-v0.3 §4.2, D7).
 *
 * Shared by the engine (spawn tighten-only checks), the validator, and host world adapters, so
 * that every host interprets `permissions.filesystem` the same way.
 */

/** Normalized scope: `{ root: true }` or the POSIX segments of a relative path. */
export type Scope = { root: true } | { root: false; segments: string[] };

export type ScopeParse = { ok: true; scope: Scope } | { ok: false; problem: ScopeProblem };

export type ScopeProblem =
  | "empty"
  | "absolute"
  | "drive"
  | "backslash_or_nul"
  | "glob"
  | "escape"
  | "implicit_root";

const ROOT_FORMS = new Set([".", "./", "*", "**"]);

/** Normalize one scope string. Root is granted only by `.`, `./`, `*`, `**`. */
export function parseScope(raw: string): ScopeParse {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, problem: "empty" };
  if (ROOT_FORMS.has(raw)) return { ok: true, scope: { root: true } };
  if (raw.startsWith("/")) return { ok: false, problem: "absolute" };
  if (/^[A-Za-z]:/.test(raw)) return { ok: false, problem: "drive" };
  if (raw.includes("\\") || raw.includes("\u0000")) return { ok: false, problem: "backslash_or_nul" };
  if (raw.includes("*")) return { ok: false, problem: "glob" };
  const stack: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (stack.length === 0) return { ok: false, problem: "escape" };
      stack.pop();
      continue;
    }
    stack.push(seg);
  }
  if (stack.length === 0) return { ok: false, problem: "implicit_root" };
  return { ok: true, scope: { root: false, segments: stack } };
}

/** Canonical text of a scope (`.` for root, else `a/b`). */
export function scopeText(scope: Scope): string {
  return scope.root ? "." : scope.segments.join("/");
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

/**
 * Is a concrete relative path (as used by a tool call) inside any of the scopes?
 * The path is normalized like a scope; root-form paths and escapes are never inside a
 * non-root scope.
 */
export function pathInScopes(path: string, scopes: readonly string[]): boolean {
  return scopeCoveredBy(path, scopes);
}
