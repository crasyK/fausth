// Rendering (spec §9): the provider-neutral request, a function of the harness and the log.
import type { Harness } from "./harness.js";
import { inScope, type Entry, type Scope } from "./log.js";
import { canonical, type Json } from "./values.js";

export type ToolCall = { call_id: string; tool: string; args: Json };
export type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; tool_calls: ToolCall[] }
  | { role: "tool"; call_id: string; tool: string; text: string };
export interface Request {
  system: string;
  tools: { name: string; description: string; input: Json }[];
  messages: Message[];
}

/** What the model sees of a tool result (§9.3). */
export function resultText(ok: boolean, value: Json): string {
  if (!ok) return canonical({ error: value });
  return typeof value === "string" ? value : canonical(value);
}

export function render(harness: Harness, entries: readonly Entry[], scope: Scope): Request {
  let system = "";
  const messages: Message[] = [];
  for (const e of entries) {
    if (!inScope(e, scope)) continue;
    if (e.type === "system") system = e.text as string;
    else if (e.type === "user") messages.push({ role: "user", text: e.text as string });
    else if (e.type === "assistant") {
      messages.push({ role: "assistant", text: e.text as string, tool_calls: e.tool_calls as ToolCall[] });
    } else if (e.type === "tool_result") {
      const text = e.ok ? resultText(true, e.result as Json) : resultText(false, e.error as Json);
      messages.push({ role: "tool", call_id: e.call_id as string, tool: e.tool as string, text });
    }
  }
  const declared = harness.tools ?? {};
  const tools = Object.keys(declared).sort().map((name) => {
    const t = declared[name]!;
    return { name, description: t.description ?? "", input: t.input ?? {} };
  });
  return { system, tools, messages };
}
