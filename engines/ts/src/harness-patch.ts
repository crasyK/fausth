/**
 * Mutable-cell harness patches (spec-v0.3 §12).
 *
 * Skills map to tool `description`; memory to `counterbalance.memory_notes`; instincts to
 * `instinct_text`. Security surfaces (permissions, sequences, checkpoints, tool id/verify/schemas)
 * are never patchable. Denials carry a closed `harness_patch` code — never prose.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.js";
import type {
  AgentIR,
  HarnessPatch,
  HarnessPatchCode,
  HarnessPatchOp,
  MutableCell,
  SkillsPatchDecline,
  SkillsPatchDeclineReason,
} from "./types.js";

export type PatchValidation =
  | { ok: true }
  | { ok: false; reason: "harness_patch_invalid" | "harness_patch_denied"; code: HarnessPatchCode };

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

export type ReflectParse =
  | { ok: true; reflect: SkillsReflect }
  | { ok: false; code: "invalid_disposition" | "invalid_decline" | "malformed_patch" };

export function parseSkillsReflectDetailed(args: Record<string, unknown>): ReflectParse {
  const disposition = args.disposition;
  if (disposition === "decline") {
    const decline = parseSkillsPatchDecline(args);
    if (!decline) return { ok: false, code: "invalid_decline" };
    return { ok: true, reflect: { disposition: "decline", ...decline } };
  }
  if (disposition === "propose") {
    const patch = parseHarnessPatch(args);
    if (!patch) return { ok: false, code: "malformed_patch" };
    return { ok: true, reflect: { disposition: "propose", patch } };
  }
  return { ok: false, code: "invalid_disposition" };
}

export function parseSkillsReflect(args: Record<string, unknown>): SkillsReflect | null {
  const r = parseSkillsReflectDetailed(args);
  return r.ok ? r.reflect : null;
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

const OP_CELL: Record<string, MutableCell> = {
  set_tool_description: "skills",
  set_memory_note: "memory",
  set_instinct_text: "instincts",
};

function cellAllowed(mutable: MutableCell[] | undefined, cell: MutableCell): boolean {
  return (mutable ?? []).includes(cell);
}

/** `{ops: [op]}` with exactly one op, else null (`malformed_patch`). */
export function parseHarnessPatch(args: Record<string, unknown>): HarnessPatch | null {
  const ops = args.ops;
  if (!Array.isArray(ops) || ops.length !== 1) return null;
  return { ops: ops as HarnessPatchOp[] };
}

/** Op checks in spec order: malformed_op, immutable_surface, unknown_op, cell_not_mutable, fields. */
export function validatePatchSecurity(agent: AgentIR, patch: HarnessPatch): PatchValidation {
  if (patch.ops.length !== 1) {
    return { ok: false, reason: "harness_patch_invalid", code: "malformed_patch" };
  }
  for (const op of patch.ops) {
    if (!op || typeof op !== "object" || Array.isArray(op) || typeof (op as HarnessPatchOp).op !== "string") {
      return { ok: false, reason: "harness_patch_invalid", code: "malformed_op" };
    }
    const kind = (op as HarnessPatchOp).op;
    if (FORBIDDEN_OPS.has(kind)) {
      return { ok: false, reason: "harness_patch_denied", code: "immutable_surface" };
    }
    const cell = OP_CELL[kind];
    if (!cell) {
      return { ok: false, reason: "harness_patch_invalid", code: "unknown_op" };
    }
    if (!cellAllowed(agent.mutable, cell)) {
      return { ok: false, reason: "harness_patch_denied", code: "cell_not_mutable" };
    }
    const o = op as unknown as Record<string, unknown>;
    if (kind === "set_tool_description") {
      if (typeof o.tool_id !== "string" || typeof o.description !== "string") {
        return { ok: false, reason: "harness_patch_invalid", code: "malformed_op" };
      }
      if (!agent.tools.some((t) => t.id === o.tool_id)) {
        return { ok: false, reason: "harness_patch_invalid", code: "unknown_tool" };
      }
    } else if (kind === "set_memory_note") {
      if (typeof o.key !== "string" || o.key.length === 0 || typeof o.note !== "string") {
        return { ok: false, reason: "harness_patch_invalid", code: "malformed_op" };
      }
    } else if (kind === "set_instinct_text") {
      if (typeof o.text !== "string") {
        return { ok: false, reason: "harness_patch_invalid", code: "malformed_op" };
      }
    }
  }
  return { ok: true };
}

/**
 * Harness hash (spec-v0.3 §12): SHA-256 of the canonical harness IR with `state` replaced by
 * the declared initial state. Run-time state and provenance are never part of it.
 */
export function harnessIrHash(agent: AgentIR, initialState?: Record<string, unknown>): string {
  const ir = initialState ? { ...agent, state: initialState } : agent;
  return createHash("sha256").update(canonicalJson(ir), "utf8").digest("hex");
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
  if (!v.ok) throw new Error(`${v.reason}: ${v.code}`);
  applyHarnessPatch(clone, patch);
  return clone;
}
