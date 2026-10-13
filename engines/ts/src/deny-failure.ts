import { sortCodePoints } from "./canonical.js";
import { evalPredicate, getPath, isMissing } from "./predicates.js";
import type {
  CounterbalanceCheckpointPolicy,
  DenyFailure,
  DenyFailureItem,
  DenyFailureUnblock,
  HarnessPatchCode,
  Predicate,
  Snapshot,
  SpawnDimension,
} from "./types.js";

/** Structured deny signals (spec-v0.3 §13.3). No prose ever enters the event log. */

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
    const current = getPath(snap, path);
    const item: DenyFailureItem = {
      path,
      current: isMissing(current) ? null : current,
      require: leafRequireConstraint(p),
    };
    if ("eq" in p && path.startsWith("state.")) {
      const unblock = lookupUnblock(path.slice("state.".length), p.eq, checkpoints);
      if (unblock) item.unblock = unblock;
    }
    failed.push(item);
  }
  return { kind: "predicate", failed };
}

export function buildMissingPriorToolsFailure(missing: string[]): DenyFailure {
  return { kind: "missing_prior_tools", missing_prior_tools: sortCodePoints(missing) };
}

export function buildMissingPriorAnyOfFailure(options: string[]): DenyFailure {
  return { kind: "missing_prior_any_of", options: sortCodePoints(options) };
}

export function buildCheckpointKeyFailure(key: string): DenyFailure {
  return { kind: "checkpoint_key", checkpoint_key: key };
}

export function buildStateKeyFailure(key: string): DenyFailure {
  return { kind: "state_key", state_key: key };
}

export function buildNonCanonicalFailure(path: string): DenyFailure {
  return { kind: "non_canonical", path };
}

export function buildSpawnFailure(
  code: "not_allowed" | "escalation" | "malformed",
  dimension?: SpawnDimension,
): DenyFailure {
  return dimension ? { kind: "spawn", code, dimension } : { kind: "spawn", code };
}

export function buildHarnessPatchFailure(code: HarnessPatchCode): DenyFailure {
  return { kind: "harness_patch", code };
}

/** Optional prose for live model tool results (hosts only); never emitted in event logs. */
export function renderDenyFailureProse(failure: DenyFailure): string | null {
  switch (failure.kind) {
    case "missing_prior_tools":
      return `Call ${failure.missing_prior_tools.join(", ")} first.`;
    case "missing_prior_any_of":
      return `Call one of: ${failure.options.join(", ")} first.`;
    case "checkpoint_key":
      return `Only the owning user checkpoint may set '${failure.checkpoint_key}'.`;
    case "state_key":
      return `State key '${failure.state_key}' is not declared by this harness.`;
    case "non_canonical":
      return `Value at ${failure.path} is not canonical JSON (integers only, no floats).`;
    case "malformed_envelope":
      return "The tool returned a malformed result envelope.";
    case "channel_unbound":
      return failure.channel === "user"
        ? "No user channel is available on this host for that tool."
        : "This host has no binding for that tool.";
    case "transcript":
      return `Recorded transcript ${failure.code} at call ${failure.call_seq}.`;
    case "host_error":
      return "The host failed to execute the tool.";
    case "adapter":
      return `Host infrastructure failure (${failure.code}).`;
    case "observation_failed":
      return "The effect could not be observed.";
    case "judge":
      return failure.code === "unavailable" ? "No judge is available." : "The judge result was invalid.";
    case "spawn":
      return failure.code === "escalation"
        ? `Spawn would widen ${failure.dimension ?? "capabilities"}.`
        : failure.code === "not_allowed"
          ? "Spawning is not allowed by this harness."
          : "Malformed spawn packet.";
    case "harness_patch":
      return `Harness patch rejected (${failure.code}).`;
    case "predicate": {
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
  }
}
