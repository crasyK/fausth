/**
 * Mutable-cell harness patches (M16).
 *
 * Skills map to tool `description` only on v0.1 IR.
 * Security surfaces (permissions, sequences, checkpoints, tool id/verify/schemas) are never patchable.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.js";
import type {
  AgentIR,
  HarnessPatch,
  HarnessPatchOp,
  MutableCell,
  ReasonCode,
  SkillsPatchDecline,
  SkillsPatchDeclineReason,
} from "./types.js";

export type PatchValidation =
  | { ok: true }
  | { ok: false; reason: ReasonCode; error: string };

export const SKILLS_PATCH_DECLINE_REASONS: readonly SkillsPatchDeclineReason[] = [
  "no_new_heuristic",
  "insufficient_evidence",
  "would_overfit_task",
  "skills_already_adequate",
] as const;

const DECLINE_REASON_SET = new Set<string>(SKILLS_PATCH_DECLINE_REASONS);

export function parseSkillsPatchDecline(
  args: Record<string, unknown>,
): SkillsPatchDecline | null {
  const reason = args.reason;
  if (typeof reason !== "string" || !DECLINE_REASON_SET.has(reason)) return null;
  const note = args.note;
  if (note !== undefined && typeof note !== "string") return null;
  return {
    reason: reason as SkillsPatchDeclineReason,
    ...(typeof note === "string" ? { note } : {}),
  };
}

/** Unified end-of-phase skills reflection (`harness.reflect_skills`). */
export type SkillsReflect =
  | ({ disposition: "decline" } & SkillsPatchDecline)
  | { disposition: "propose"; patch: HarnessPatch };

export function parseSkillsReflect(args: Record<string, unknown>): SkillsReflect | null {
  const disposition = args.disposition;
  if (disposition === "decline") {
    const decline = parseSkillsPatchDecline(args);
    if (!decline) return null;
    return { disposition: "decline", ...decline };
  }
  if (disposition === "propose") {
    const patch = parseHarnessPatch(args);
    if (!patch) return null;
    return { disposition: "propose", patch };
  }
  return null;
}

const FORBIDDEN_OPS = new Set([
  "set_permissions_tools",
  "set_sequences",
  "set_checkpoints",
  "set_tool_id",
  "set_tool_verify",
  "set_tool_input",
  "set_tool_output",
]);

function cellAllowed(mutable: MutableCell[] | undefined, cell: MutableCell): boolean {
  return (mutable ?? []).includes(cell);
}

export function parseHarnessPatch(args: Record<string, unknown>): HarnessPatch | null {
  const ops = args.ops;
  if (!Array.isArray(ops) || ops.length === 0) return null;
  if (ops.length > 1) return null;
  return { ops: ops as HarnessPatchOp[] };
}

export function validatePatchSecurity(
  agent: AgentIR,
  patch: HarnessPatch,
): PatchValidation {
  if (!patch.ops.length) {
    return { ok: false, reason: "harness_patch_invalid", error: "empty patch" };
  }
  for (const op of patch.ops) {
    if (!op || typeof op !== "object" || typeof (op as HarnessPatchOp).op !== "string") {
      return { ok: false, reason: "harness_patch_invalid", error: "malformed patch op" };
    }
    const kind = (op as HarnessPatchOp).op;
    if (FORBIDDEN_OPS.has(kind)) {
      return {
        ok: false,
        reason: "harness_patch_denied",
        error: `op '${kind}' mutates immutable security/capability surface`,
      };
    }
    if (kind === "set_tool_description") {
      if (!cellAllowed(agent.mutable, "skills")) {
        return {
          ok: false,
          reason: "harness_patch_denied",
          error: "skills not in mutable; cannot set_tool_description",
        };
      }
      const toolId = String((op as { tool_id?: string }).tool_id ?? "");
      if (!agent.tools.some((t) => t.id === toolId)) {
        return {
          ok: false,
          reason: "harness_patch_invalid",
          error: `unknown tool_id '${toolId}'`,
        };
      }
      if (typeof (op as { description?: unknown }).description !== "string") {
        return {
          ok: false,
          reason: "harness_patch_invalid",
          error: "set_tool_description requires string description",
        };
      }
    } else if (kind === "set_memory_note") {
      if (!cellAllowed(agent.mutable, "memory")) {
        return {
          ok: false,
          reason: "harness_patch_denied",
          error: "memory not in mutable; cannot set_memory_note",
        };
      }
      const key = String((op as { key?: string }).key ?? "");
      if (!key) {
        return { ok: false, reason: "harness_patch_invalid", error: "set_memory_note requires key" };
      }
      if (typeof (op as { note?: unknown }).note !== "string") {
        return {
          ok: false,
          reason: "harness_patch_invalid",
          error: "set_memory_note requires string note",
        };
      }
    } else if (kind === "set_instinct_text") {
      if (!cellAllowed(agent.mutable, "instincts")) {
        return {
          ok: false,
          reason: "harness_patch_denied",
          error: "instincts not in mutable; cannot set_instinct_text",
        };
      }
      if (typeof (op as { text?: unknown }).text !== "string") {
        return {
          ok: false,
          reason: "harness_patch_invalid",
          error: "set_instinct_text requires string text",
        };
      }
    } else {
      return {
        ok: false,
        reason: "harness_patch_invalid",
        error: `unknown patch op '${kind}'`,
      };
    }
  }
  return { ok: true };
}

export function harnessIrHash(agent: AgentIR): string {
  return createHash("sha256").update(canonicalJson(agent), "utf8").digest("hex");
}

/** Apply a validated patch in place. Caller must validatePatchSecurity first. */
export function applyHarnessPatch(agent: AgentIR, patch: HarnessPatch): void {
  for (const op of patch.ops) {
    if (op.op === "set_tool_description") {
      const tool = agent.tools.find((t) => t.id === op.tool_id);
      if (tool) tool.description = op.description;
    } else if (op.op === "set_memory_note") {
      if (!agent.counterbalance) agent.counterbalance = {};
      if (!agent.counterbalance.memory_notes) agent.counterbalance.memory_notes = {};
      agent.counterbalance.memory_notes[op.key] = op.note;
    } else if (op.op === "set_instinct_text") {
      agent.instinct_text = op.text;
    }
  }
}

/** Apply candidate patch to a clone; throws on validation failure. */
export function applyCandidatePatch(agent: AgentIR, patch: HarnessPatch): AgentIR {
  const clone = structuredClone(agent);
  const v = validatePatchSecurity(clone, patch);
  if (!v.ok) throw new Error(`${v.reason}: ${v.error}`);
  applyHarnessPatch(clone, patch);
  return clone;
}
