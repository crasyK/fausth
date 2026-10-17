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

/** The wrapper of a hook decision (§9.2). */
export function hookWrapper(event: string, id: string, decision: string, text: string): string {
  return `<hook event="${event}" id="${id}" decision="${decision}">${text.replaceAll("</hook>", "&lt;/hook>")}</hook>`;
}

/** The wrapper of a delivered interrupt (§9.2). */
export function interruptWrapper(source: string, text: string): string {
  return `<interrupt source="${source}">${text.replaceAll("</interrupt>", "&lt;/interrupt>")}</interrupt>`;
}

/** What the model sees of a tool result (§9.3). */
export function resultText(ok: boolean, value: Json): string {
  if (!ok) return canonical({ error: value });
  return typeof value === "string" ? value : canonical(value);
}

/** A call's tool message while its log entries are read (§9.3). */
interface Slot {
  call_id: string;
  tool: string;
  modifies: string[];
  result?: string;
  denied?: string;
  replaced?: string;
  contexts: string[];
}
type Item = { role: "user"; text: string } | { role: "assistant"; text: string; tool_calls: ToolCall[] } | { role: "tool"; slot: Slot };

const joined = (parts: string[]) => parts.map((p) => `\n\n${p}`).join("");

export function render(harness: Harness, entries: readonly Entry[], scope: Scope): Request {
  let system = "";
  let items: Item[] = [];
  const slots = new Map<string, Slot>();
  let userContexts: string[] = [];
  let interruptContexts: string[] = [];

  for (const e of entries) {
    if (!inScope(e, scope)) continue;
    if (e.type === "system") system = e.text as string;
    else if (e.type === "user") {
      items.push({ role: "user", text: (e.text as string) + joined(userContexts) });
      userContexts = [];
    } else if (e.type === "interrupt") {
      items.push({ role: "user", text: interruptWrapper(e.source as string, e.text as string) + joined(interruptContexts) });
      interruptContexts = [];
    } else if (e.type === "assistant") {
      const calls = e.tool_calls as ToolCall[];
      items.push({ role: "assistant", text: e.text as string, tool_calls: calls });
      for (const c of calls) {
        const slot: Slot = { call_id: c.call_id, tool: c.tool, modifies: [], contexts: [] };
        slots.set(c.call_id, slot);
        items.push({ role: "tool", slot });
      }
    } else if (e.type === "tool_result") {
      const slot = slots.get(e.call_id as string);
      if (slot) slot.result = e.ok ? resultText(true, e.result as Json) : resultText(false, e.error as Json);
    } else if (e.type === "hook") {
      const event = e.event as string;
      const decision = e.decision as string;
      const text = decision === "modify" ? ((e.text as string | undefined) ?? "args changed") : (e.text as string);
      const wrapper = text === undefined ? "" : hookWrapper(event, e.hook as string, decision, text);
      const slot = typeof e.call_id === "string" ? slots.get(e.call_id) : undefined;
      if (slot) {
        if (decision === "modify") slot.modifies.push(wrapper);
        else if (decision === "deny") slot.denied = wrapper;
        else if (decision === "replace") slot.replaced = wrapper;
        else if (decision === "add_context") slot.contexts.push(wrapper);
      } else if (event === "user_prompt") {
        if (decision === "add_context") userContexts.push(wrapper);
        if (decision === "deny") userContexts = [];
      } else if (event === "interrupt") {
        if (decision === "add_context") interruptContexts.push(wrapper);
        if (decision === "deny") interruptContexts = [];
      } else if (event === "pre_request" && decision === "replace_context") {
        items = [{ role: "user", text: wrapper }];
      } else if ((event === "pre_request" || event === "stop") && (decision === "add_context" || decision === "continue")) {
        items.push({ role: "user", text: wrapper });
      }
    }
  }

  const messages: Message[] = [];
  for (const item of items) {
    let message: Message;
    if (item.role === "tool") {
      const s = item.slot;
      const body = s.denied ?? s.replaced ?? s.result;
      if (body === undefined) continue; // the call never finished
      message = { role: "tool", call_id: s.call_id, tool: s.tool, text: s.modifies.map((m) => `${m}\n`).join("") + body + joined(s.contexts) };
    } else message = { ...item };
    const last = messages.at(-1);
    if (message.role === "user" && last?.role === "user") last.text += `\n\n${message.text}`;
    else messages.push(message);
  }

  const declared = harness.tools ?? {};
  const tools = Object.keys(declared).sort().map((name) => {
    const t = declared[name]!;
    return { name, description: t.description ?? "", input: t.input ?? {} };
  });
  return { system, tools, messages };
}
