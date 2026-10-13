/**
 * Deny-log audit — treat closed reason codes as a measurement grammar.
 */
import { existsSync } from "node:fs";
import { readJsonl } from "./load.js";

export type AuditSummary = {
  source: string;
  events: number;
  denies: number;
  by_reason: Record<string, number>;
  capability_missing: number;
  structured_failures: Record<string, number>;
  near_misses: number;
  verify_output_failed: number;
  memory_stale: number;
  budget_exceeded: number;
};

export type AuditEvent = {
  stage?: string;
  verdict?: string;
  reason?: string;
  tool?: string;
  depth?: number;
  spawn_id?: string;
  failure?: { kind?: string };
};

/**
 * Near-miss: a denied attempt of tool T whose NEXT attempt in the same reaction (same depth and
 * spawn) is again T and is denied again (spec-v0.3 §13; CORE-18). An attempt starts at a
 * `propose` event that names a tool and runs until the next such `propose`; it is denied when any
 * of its events has a `deny`/`safe_state` verdict. Orientation, record and nested-child events in
 * between do not break the pairing.
 */
function countNearMisses(events: AuditEvent[]): number {
  type Attempt = { tool: string; denied: boolean };
  const byReaction = new Map<string, Attempt[]>();
  const current = new Map<string, Attempt>();
  for (const e of events) {
    const key = `${e.depth ?? 0}|${e.spawn_id ?? ""}`;
    if (e.stage === "propose" && e.tool) {
      const attempt: Attempt = { tool: e.tool, denied: e.verdict === "deny" };
      const list = byReaction.get(key) ?? [];
      list.push(attempt);
      byReaction.set(key, list);
      current.set(key, attempt);
      continue;
    }
    const attempt = current.get(key);
    if (!attempt) continue;
    if (e.stage === "propose") {
      // A stop / invalid proposal ends the current attempt.
      current.delete(key);
      continue;
    }
    if (e.verdict === "deny" || e.verdict === "safe_state") attempt.denied = true;
  }
  let n = 0;
  for (const list of byReaction.values()) {
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1]!;
      const b = list[i]!;
      if (a.denied && b.denied && a.tool === b.tool) n += 1;
    }
  }
  return n;
}

export function auditEvents(events: AuditEvent[], source = "<memory>"): AuditSummary {
  const by_reason: Record<string, number> = {};
  const structured_failures: Record<string, number> = {};
  let denies = 0;
  let capability_missing = 0;
  let verify_output_failed = 0;
  let memory_stale = 0;
  let budget_exceeded = 0;

  for (const e of events) {
    if (e.verdict === "deny") {
      denies += 1;
      const r = e.reason ?? "unknown";
      by_reason[r] = (by_reason[r] ?? 0) + 1;
      if (r === "capability_missing") capability_missing += 1;
      if (r === "verify_output_failed") verify_output_failed += 1;
      if (e.failure?.kind) {
        structured_failures[e.failure.kind] = (structured_failures[e.failure.kind] ?? 0) + 1;
      }
    }
    if (e.reason === "memory_stale") memory_stale += 1;
    if (e.reason === "budget_exceeded") budget_exceeded += 1;
  }

  return {
    source,
    events: events.length,
    denies,
    by_reason,
    capability_missing,
    structured_failures,
    near_misses: countNearMisses(events),
    verify_output_failed,
    memory_stale,
    budget_exceeded,
  };
}

export function auditJsonlFile(path: string): AuditSummary {
  if (!existsSync(path)) {
    throw new Error(`audit: file not found: ${path}`);
  }
  return auditEvents(readJsonl(path) as AuditEvent[], path);
}

export function formatAuditHuman(s: AuditSummary): string {
  const reasons = Object.entries(s.by_reason)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");
  const failures = Object.entries(s.structured_failures)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");
  return [
    `fausth audit — ${s.source}`,
    `events: ${s.events}  denies: ${s.denies}  near_misses: ${s.near_misses}`,
    `capability_missing: ${s.capability_missing}  verify_output_failed: ${s.verify_output_failed}`,
    `memory_stale: ${s.memory_stale}  budget_exceeded: ${s.budget_exceeded}`,
    reasons ? `by_reason:\n${reasons}` : "by_reason: (none)",
    failures ? `structured_failures:\n${failures}` : "structured_failures: (none)",
  ].join("\n");
}
