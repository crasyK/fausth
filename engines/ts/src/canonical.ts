import { createHash } from "node:crypto";
import { INT53_MAX, INT53_MIN } from "./types.js";

/**
 * Canonical JSON (spec-v0.3 §1).
 *
 * - Object keys sort by Unicode code point (D1), not UTF-16 code unit.
 * - Integral numbers (incl. 1.0, 1e3, -0) are int53 integers; anything else is non-canonical (D3).
 * - Strings must be well-formed Unicode.
 * - Object members whose value is `undefined` are absent.
 */

/** Compare two strings by Unicode code point sequence (spec-v0.3 §1.2). */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0)!;
    const cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

/** Sort a string list by code point (returns a new array). */
export function sortCodePoints(xs: Iterable<string>): string[] {
  return [...xs].sort(compareCodePoints);
}

/** Number of Unicode code points (D2). */
export function cpLength(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

export const TRUNCATION_SUFFIX = "…[truncated]";

/** First `n` code points of `s` + suffix when longer (spec-v0.3 §1.4). */
export function excerpt(s: string, n: number): string {
  if (s.length <= n) return s; // UTF-16 length ≥ code point length
  let out = "";
  let i = 0;
  for (const ch of s) {
    if (i >= n) return out + TRUNCATION_SUFFIX;
    out += ch;
    i += 1;
  }
  return out;
}

export type CanonicalCheck =
  | { ok: true; value: unknown }
  | { ok: false; path: string; problem: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isWellFormed(s: string): boolean {
  const f = (s as unknown as { isWellFormed?: () => boolean }).isWellFormed;
  if (typeof f === "function") return f.call(s);
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

function memberPath(path: string, key: string): string {
  return `${path}.${key}`;
}

/**
 * Normalize a host value to a canonical JSON value, or report the first non-canonical
 * location (depth-first, object members in code point order). Never throws.
 */
export function toCanonical(value: unknown, path = "$"): CanonicalCheck {
  if (value === null || typeof value === "boolean") return { ok: true, value };
  if (typeof value === "string") {
    return isWellFormed(value)
      ? { ok: true, value }
      : { ok: false, path, problem: "string is not well-formed Unicode" };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      return { ok: false, path, problem: "non-integral number" };
    }
    if (value < INT53_MIN || value > INT53_MAX) {
      return { ok: false, path, problem: "integer outside int53" };
    }
    return { ok: true, value: value === 0 ? 0 : value };
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (item === undefined) return { ok: false, path: `${path}[${i}]`, problem: "undefined array item" };
      const r = toCanonical(item, `${path}[${i}]`);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return { ok: true, value: out };
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of sortCodePoints(Object.keys(value))) {
      if (!isWellFormed(key)) return { ok: false, path, problem: "key is not well-formed Unicode" };
      const v = value[key];
      if (v === undefined) continue;
      const r = toCanonical(v, memberPath(path, key));
      if (!r.ok) return r;
      out[key] = r.value;
    }
    return { ok: true, value: out };
  }
  return { ok: false, path, problem: `unsupported type ${typeof value}` };
}

/** True iff `value` is a canonical JSON value. */
export function isCanonical(value: unknown): boolean {
  return toCanonical(value).ok;
}

function serialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of sortCodePoints(Object.keys(obj))) {
    parts.push(`${JSON.stringify(key)}:${serialize(obj[key])}`);
  }
  return `{${parts.join(",")}}`;
}

/** Compact canonical JSON. Throws on non-canonical input (callers validate at entry). */
export function canonicalJson(value: unknown): string {
  const r = toCanonical(value);
  if (!r.ok) throw new Error(`Non-canonical value at ${r.path}: ${r.problem}`);
  return serialize(r.value);
}

/** Deep equality via canonical JSON (portable across runtimes). */
export function deepEq(a: unknown, b: unknown): boolean {
  const ra = toCanonical(a);
  const rb = toCanonical(b);
  if (!ra.ok || !rb.ok) return false;
  return serialize(ra.value) === serialize(rb.value);
}

export function stateHash(state: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(state), "utf8").digest("hex");
}

export function eventLine(event: unknown): string {
  return canonicalJson(event);
}
