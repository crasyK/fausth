import { deepEq } from "./canonical.js";
import type { Predicate, Snapshot } from "./types.js";

/** Internal sentinel — distinct from JSON null. Never serialized. */
export const MISSING: unique symbol = Symbol("fausth.MISSING");

export type PathValue = unknown | typeof MISSING;

export function getPath(snapshot: Snapshot, path: string): PathValue {
  const parts = path.split(".");
  let cur: unknown = snapshot;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") {
      return MISSING;
    }
    const obj = cur as Record<string, unknown>;
    if (!(p in obj)) {
      return MISSING;
    }
    cur = obj[p];
  }
  return cur;
}

export function isMissing(v: PathValue): v is typeof MISSING {
  return v === MISSING;
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
  if (isMissing(value) || typeof value !== "number" || !Number.isInteger(value)) {
    return false;
  }
  if ("lt" in pred) return value < pred.lt;
  if ("lte" in pred) return value <= pred.lte;
  if ("gt" in pred) return value > pred.gt;
  if ("gte" in pred) return value >= pred.gte;
  return false;
}
