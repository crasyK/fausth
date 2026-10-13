/**
 * Host-side CLI helpers (kept out of cli.ts, which runs main() on import, so they are testable).
 */
import type { AgentIR, Event } from "./types.js";

/** System context built only from harness-declared text (spec-v0.3 §15.3). */
export function systemPromptFor(agent: AgentIR, overlayHint?: string): string {
  const parts = [`You are ${agent.name}.`];
  if (agent.instinct_text) parts.push(agent.instinct_text);
  if (overlayHint) parts.push(overlayHint);
  return parts.join("\n\n");
}

/** Tools offered to the model: exactly the permitted set (spec-v0.3 §4.1). */
export function permittedToolDefs(agent: AgentIR) {
  const permitted = agent.permissions?.tools;
  return agent.tools.filter((t) => permitted === undefined || permitted.includes(t.id));
}

/** A run succeeded iff the top-level reaction recorded run_complete (D8). */
export function runCompleted(events: Event[]): boolean {
  return events.some((e) => e.depth === undefined && e.stage === "record" && e.reason === "run_complete");
}

const POLICY_DENY_REASONS = new Set([
  "gate_denied",
  "capability_missing",
  "sequence_requirement_failed",
  "completion_gate_failed",
  "checkpoint_authority_failed",
  "harness_patch_denied",
]);

/** Genuine pre-execution policy denies of attempted actions (spec-v0.3 §15.3). */
export function isPreExecutionPolicyDeny(e: Event): boolean {
  if (e.stage !== "validate" && e.stage !== "authorize") return false;
  if (e.verdict !== "deny" && e.verdict !== "safe_state") return false;
  if (!e.reason || !POLICY_DENY_REASONS.has(e.reason)) return false;
  if (e.failure?.kind === "channel_unbound") return false;
  return true;
}

/** Last integer `result.exit_code` of a successful top-level execute (generic; no tool names). */
export function lastExitCode(events: Event[]): number | null {
  for (const e of [...events].reverse()) {
    if (e.depth !== undefined || e.stage !== "execute" || e.verdict !== "allow") continue;
    const code = (e.result as { exit_code?: unknown } | undefined)?.exit_code;
    if (typeof code === "number" && Number.isInteger(code)) return code;
  }
  return null;
}

/** Flags that never consume the next token unless it is an explicit boolean literal. */
const BOOLEAN_FLAGS = new Set([
  "expect-complete",
  "apply-overlays",
  "skip-fixtures",
  "force",
  "json",
  "post",
  "check-run",
  "comment",
  "annotate",
]);

const BOOLEAN_LITERALS = new Set(["true", "false", "1", "0"]);

/**
 * `--flag value`, `--flag=value`, boolean flags (`--expect-complete [true|false|1|0]`) and
 * positionals. A boolean flag never swallows a positional (CORE-17).
 */
export function parseArgs(argv: string[]): { flags: Record<string, string>; positionals: string[] } {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const body = a.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    if (BOOLEAN_FLAGS.has(body)) {
      const next = argv[i + 1];
      if (next !== undefined && BOOLEAN_LITERALS.has(next)) {
        flags[body] = next;
        i += 1;
      } else {
        flags[body] = "true";
      }
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[body] = "true";
    } else {
      flags[body] = next;
      i += 1;
    }
  }
  return { flags, positionals };
}

export function flagOn(flags: Record<string, string>, name: string): boolean {
  return flags[name] === "true" || flags[name] === "1";
}

