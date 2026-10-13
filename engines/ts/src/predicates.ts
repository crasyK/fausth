import { deepEq } from "./canonical.js";
import type { Predicate, Snapshot } from "./types.js";

/** Internal sentinel — distinct from JSON null. Never serialized. */
export const MISSING: unique symbol = Symbol("fausth.MISSING");

export type PathValue = unknown | typeof MISSING;

/** Snapshot roots and the contexts that may use them (spec-v0.3 §3.2). */
export const SNAPSHOT_ROOTS = [
  "action",
  "state",
  "result",
  "observation",
  "judgment",
  "message",
] as const;

function isJsonObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Resolve a dotted path against a snapshot (spec-v0.3 §3.2, D16).
 * Each segment selects an OWN member of a JSON object. Arrays, strings, numbers, booleans and
 * null have no members (no implicit `.length`, no indexing); inherited members never resolve.
 */
export function getPath(snapshot: Snapshot, path: string): PathValue {
  const parts = path.split(".");
  let cur: unknown = snapshot;
  for (const p of parts) {
    if (!isJsonObject(cur)) return MISSING;
    if (!Object.prototype.hasOwnProperty.call(cur, p)) return MISSING;
    cur = cur[p];
    if (cur === undefined) return MISSING;
  }
  return cur;
}

export function isMissing(v: PathValue): v is typeof MISSING {
  return v === MISSING;
}

function isInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

export function evalPredicate(pred: Predicate, snapshot: Snapshot): boolean {
  if ("all" in pred) {
    return pred.all.every((p) => evalPredicate(p, snapshot));
  }
  if ("any" in pred) {
    return pred.any.some((p) => evalPredicate(p, snapshot));
  }
  if ("not" in pred) {
    return !evalPredicate(pred.not, snapshot);
  }
  const value = getPath(snapshot, pred.path);
  if ("eq_path" in pred) {
    const other = getPath(snapshot, pred.eq_path);
    if (isMissing(value) && isMissing(other)) return true;
    if (isMissing(value) || isMissing(other)) return false;
    return deepEq(value, other);
  }
  if ("eq" in pred) {
    if (isMissing(value)) return false;
    return deepEq(value, pred.eq);
  }
  if ("neq" in pred) {
    // Missing is absent, not "not equal"
    if (isMissing(value)) return false;
    return !deepEq(value, pred.neq);
  }
  if (isMissing(value) || !isInteger(value)) {
    return false;
  }
  if ("lt" in pred) return value < pred.lt;
  if ("lte" in pred) return value <= pred.lte;
  if ("gt" in pred) return value > pred.gt;
  if ("gte" in pred) return value >= pred.gte;
  return false;
}

/** Every `path` / `eq_path` string inside a predicate tree, in tree order. */
export function predicatePaths(pred: unknown, out: string[] = []): string[] {
  if (!pred || typeof pred !== "object") return out;
  const p = pred as Record<string, unknown>;
  if (typeof p.path === "string") out.push(p.path);
  if (typeof p.eq_path === "string") out.push(p.eq_path);
  if (Array.isArray(p.all)) for (const x of p.all) predicatePaths(x, out);
  if (Array.isArray(p.any)) for (const x of p.any) predicatePaths(x, out);
  if (p.not) predicatePaths(p.not, out);
  return out;
}
