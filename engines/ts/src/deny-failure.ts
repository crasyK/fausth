import { evalPredicate, getPath, isMissing } from "./predicates.js";
import type {
  CounterbalanceCheckpointPolicy,
  DenyFailure,
  DenyFailureItem,
  DenyFailureUnblock,
  Predicate,
  Snapshot,
} from "./types.js";

function leafRequireConstraint(p: Predicate): Record<string, unknown> {
  if ("eq" in p) return { eq: p.eq };
  if ("neq" in p) return { neq: p.neq };
  if ("eq_path" in p) return { eq_path: p.eq_path };
  if ("lt" in p) return { lt: p.lt };
  if ("lte" in p) return { lte: p.lte };
  if ("gt" in p) return { gt: p.gt };
  if ("gte" in p) return { gte: p.gte };
  return {};
}

export function failingPredicates(pred: Predicate, snap: Snapshot): Predicate[] {
  if ("all" in pred) {
    return pred.all.flatMap((p) => failingPredicates(p, snap));
  }
  if ("any" in pred) {
    if (evalPredicate(pred, snap)) return [];
    return pred.any.flatMap((p) => failingPredicates(p, snap));
  }
  if ("not" in pred) {
    return evalPredicate(pred.not, snap) ? [pred] : [];
  }
  return evalPredicate(pred, snap) ? [] : [pred];
}

function lookupUnblock(
  key: string,
  eqValue: unknown,
  checkpoints: CounterbalanceCheckpointPolicy[],
): DenyFailureUnblock | undefined {
  for (const cp of checkpoints) {
    if (cp.allow_set_keys.includes(key)) {
      return { tool: cp.tool, set_key: key, set_value: eqValue };
    }
  }
  return undefined;
}

export function buildPredicateFailure(
  pred: Predicate,
  snap: Snapshot,
  checkpoints: CounterbalanceCheckpointPolicy[] = [],
): DenyFailure {
  const failed: DenyFailureItem[] = [];
  for (const p of failingPredicates(pred, snap)) {
    if (!("path" in p)) continue;
    const path = p.path;
    const key = path.startsWith("state.") ? path.slice("state.".length) : path;
    const current = getPath(snap, path);
    const item: DenyFailureItem = {
      path,
      current: isMissing(current) ? null : current,
      require: leafRequireConstraint(p),
    };
    if ("eq" in p) {
      const unblock = lookupUnblock(key, p.eq, checkpoints);
      if (unblock) item.unblock = unblock;
    }
    failed.push(item);
  }
  return { kind: "predicate", failed };
}

export function buildMissingPriorToolsFailure(missing: string[]): DenyFailure {
  return { kind: "missing_prior_tools", missing_prior_tools: [...missing].sort() };
}

export function buildMissingPriorAnyOfFailure(options: string[]): DenyFailure {
  return { kind: "missing_prior_any_of", options: [...options].sort() };
}

export function buildCheckpointKeyFailure(key: string): DenyFailure {
  return { kind: "checkpoint_key", checkpoint_key: key };
}

/** Optional prose for live model tool results; not emitted in event logs. */
export function renderDenyFailureProse(failure: DenyFailure): string | null {
  if (failure.kind === "missing_prior_tools") {
    return `Call ${failure.missing_prior_tools.join(", ")} first.`;
  }
  if (failure.kind === "missing_prior_any_of") {
    return `Call one of: ${failure.options.join(", ")} first.`;
  }
  if (failure.kind === "checkpoint_key") {
    return `Checkpoint tool may not set '${failure.checkpoint_key}'.`;
  }
  const parts = failure.failed.map((f) => {
    const req = JSON.stringify(f.require);
    const cur = f.current === null ? "missing" : JSON.stringify(f.current);
    const unblock = f.unblock
      ? ` Call ${f.unblock.tool} with set ${JSON.stringify({ [f.unblock.set_key]: f.unblock.set_value })}.`
      : "";
    return `${f.path} requires ${req} (currently ${cur}).${unblock}`;
  });
  return parts.length > 0 ? parts.join(" ") : null;
}
