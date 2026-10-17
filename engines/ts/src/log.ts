// The log (spec §7) and the view that hooks see (§5.3).
import { canonical, type Json } from "./values.js";

export type Entry = { seq: number; type: string; [member: string]: Json };

/** Where a run writes: the top level (depth 0), or a child of the `core_spawn` call `parent_call`. */
export interface Scope { depth: number; parent_call?: string }

export const TOP: Scope = { depth: 0 };

export type ViewEntry =
  | { step: number; tool: string; args: Json; ok: true; result: Json }
  | { step: number; tool: string; args: Json; ok: false; error: string }
  | { step: number; interrupt: { source: string; text: string } };

/** One log for a whole run, child runs included: `seq` counts from 1 across all of it. */
export class Log {
  readonly entries: Entry[] = [];

  /** Append an entry written by the run in `scope`. Absent members are left out by the caller. */
  append(scope: Scope, type: string, members: { [member: string]: Json }): Entry {
    const entry: Entry = { seq: this.entries.length + 1, type, ...members };
    if (scope.depth > 0) {
      entry.depth = scope.depth;
      entry.parent_call = scope.parent_call ?? null;
    }
    this.entries.push(entry);
    return entry;
  }

  /** JSON Lines: one canonical object per line, each line ending with "\n". */
  text(): string {
    return this.entries.map((e) => `${canonical(e)}\n`).join("");
  }
}

export function callId(assistantSeq: number, index: number): string {
  return `c${assistantSeq}-${index}`;
}

export function inScope(e: Entry, scope: Scope): boolean {
  return (e.depth ?? 0) === scope.depth && (e.parent_call ?? undefined) === scope.parent_call;
}

/** The view of the run in `scope` (§5.3): its finished tool calls and delivered interrupts. */
export function view(entries: readonly Entry[], scope: Scope): ViewEntry[] {
  const calls = new Map<string, { step: number; tool: string; args: Json }>();
  const out: ViewEntry[] = [];
  for (const e of entries) {
    if (!inScope(e, scope)) continue;
    if (e.type === "assistant") {
      for (const c of e.tool_calls as { call_id: string; tool: string; args: Json }[]) {
        calls.set(c.call_id, { step: e.step as number, tool: c.tool, args: c.args });
      }
    } else if (e.type === "hook" && typeof e.call_id === "string") {
      const call = calls.get(e.call_id);
      if (call && e.decision === "modify") call.args = e.args as Json;
      if (call && e.decision === "deny") out.push({ ...call, ok: false, error: e.text as string });
    } else if (e.type === "tool_result") {
      const call = calls.get(e.call_id as string);
      if (!call) continue;
      out.push(e.ok ? { ...call, ok: true, result: e.result as Json } : { ...call, ok: false, error: e.error as string });
    } else if (e.type === "interrupt") {
      out.push({ step: e.step as number, interrupt: { source: e.source as string, text: e.text as string } });
    }
  }
  return out;
}
