import type { ToolDef } from "../types.js";

export type ChatMessage = {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
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

export type ModelProposal =
  | {
      type: "tool";
      name: string;
      args: Record<string, unknown>;
      /** OpenAI tool_call id — needed to continue multi-turn tool chats */
      tool_call_id?: string;
      /** Opaque transport tool name (faust_tool_0001) for transcript continuity */
      transport_name?: string;
    }
  | { type: "stop"; message?: string }
  | { type: "invalid"; reason: string; raw?: string };

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
