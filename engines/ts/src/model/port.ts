import type { ModelProposal as RuntimeModelProposal, ToolDef } from "../types.js";
import type { ModelProtocolInvalidReason } from "./errors.js";

export type ChatMessage = {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  /**
   * Host-side metadata (never sent as-is): the model that produced this assistant turn.
   * Transports use it to scope preserved provider fields to the same model.
   */
  model?: string;
  /**
   * Host-side metadata: provider response fields preserved for this assistant turn
   * (e.g. `reasoning_details`). Transports re-attach them to this message on the wire
   * only when the next request goes to the same `model`.
   */
  provider_fields?: Record<string, unknown>;
};

export type ModelToolDef = {
  id: string;
  description?: string;
  input?: Record<string, unknown>;
};

export type ModelToolChoice = "auto" | "required";

export type ModelProposeRequest = {
  messages: ChatMessage[];
  tools: ModelToolDef[];
  /** When tools are offered, agent loops should prefer "required". */
  tool_choice?: ModelToolChoice;
};

/** Fields every transport proposal may carry for transcript continuity. */
type ProposalProvenance = {
  /** Model id that produced this proposal (after any fallback). */
  model?: string;
  /** Preserved provider fields from the response message (see ChatMessage.provider_fields). */
  provider_fields?: Record<string, unknown>;
};

/**
 * Transport-level proposal. Infra failures are never proposals — transports throw
 * `ModelInfraError` (see errors.ts); `invalid` is reserved for model-protocol failures.
 */
export type ModelProposal =
  | ({
      type: "tool";
      name: string;
      args: Record<string, unknown>;
      /** OpenAI tool_call id — needed to continue multi-turn tool chats */
      tool_call_id?: string;
      /** Opaque transport tool name (faust_tool_0001) for transcript continuity */
      transport_name?: string;
    } & ProposalProvenance)
  | ({ type: "stop"; message?: string } & ProposalProvenance)
  | ({ type: "invalid"; reason: ModelProtocolInvalidReason; raw?: string } & ProposalProvenance);

/** Runtime-facing model port — providers terminate here. */
export interface ModelPort {
  lastModelUsed: string;
  propose(input: ModelProposeRequest): Promise<ModelProposal>;
}

export function toolsFromAgent(tools: ToolDef[]): ModelToolDef[] {
  return tools.map((t) => ({
    id: t.id,
    description: t.description,
    input: t.input,
  }));
}

/**
 * Map a transport proposal onto the runtime's proposal type without losing class:
 * `invalid` stays `invalid` (it is a model-protocol failure, not a stop).
 */
export function toRuntimeProposal(p: ModelProposal): RuntimeModelProposal {
  if (p.type === "tool") return { type: "tool", name: p.name, args: p.args };
  if (p.type === "stop") return { type: "stop", message: p.message };
  return { type: "invalid", reason: p.reason, message: p.raw ?? p.reason };
}
