/**
 * Deny-log audit — treat closed reason codes as a measurement grammar.
 */
import { readFileSync, existsSync } from "node:fs";

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
  failure?: { kind?: string };
};

function readJsonl(path: string): AuditEvent[] {
  const raw = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as AuditEvent);
}

/** Count deny→retry→deny sequences on the same tool as near-misses. */
function countNearMisses(events: AuditEvent[]): number {
  let n = 0;
  for (let i = 0; i < events.length - 2; i++) {
    const a = events[i]!;
    const b = events[i + 1]!;
    const c = events[i + 2]!;
    if (
      a.verdict === "deny" &&
      a.tool &&
      b.stage === "propose" &&
      b.tool === a.tool &&
      c.verdict === "deny" &&
      c.tool === a.tool
    ) {
      n += 1;
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
  return auditEvents(readJsonl(path), path);
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
