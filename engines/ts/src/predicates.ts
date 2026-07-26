import type { Predicate, Snapshot } from "./types.js";

export function getPath(snapshot: Snapshot, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = snapshot;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function deepEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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
    return deepEq(value, getPath(snapshot, pred.eq_path));
  }
  if ("eq" in pred) return deepEq(value, pred.eq);
  if ("neq" in pred) return !deepEq(value, pred.neq);
  if (typeof value !== "number" || !Number.isInteger(value)) return false;
  if ("lt" in pred) return value < pred.lt;
  if ("lte" in pred) return value <= pred.lte;
  if ("gt" in pred) return value > pred.gt;
  if ("gte" in pred) return value >= pred.gte;
  return false;
}
