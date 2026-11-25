// Rendering (spec §9): the provider-neutral request, a function of the harness and the log.
import { fill, shownTool, toolIds, type Harness } from "./harness.js";
import { inScope, type Entry, type Scope } from "./log.js";
import { canonical, type Json } from "./values.js";

/** A tool call as the request carries it (§9): `args_text` only when it isn't the canonical form of `args` (§9.4). */
export type ToolCall = { call_id: string; tool: string; args: Json; args_text?: string };
/** A tool call as the log holds it (§7): also `malformed`, the model's text when it wasn't JSON. */
export type LoggedCall = ToolCall & { malformed?: string };
export type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; tool_calls: ToolCall[]; reasoning?: string; reasoning_opaque?: Json }
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

/** What the model sees of a tool result (§9.3); a failed one through the harness's `tool_error` text, if any (§8.2). */
export function resultText(ok: boolean, value: Json, toolError?: string): string {
  if (!ok) return toolError === undefined ? canonical({ error: value }) : fill(toolError, { error: value as string });
  return typeof value === "string" ? value : canonical(value);
}

/** The argument text of a call (§9.4): its `args_text`, else the canonical form of its `args`. */
export function argsText(call: ToolCall): string {
  return call.args_text ?? canonical(call.args);
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
/** A message so far, or a tool message still being read. `kept`: a message a `replace_context` kept, which
 * stays as it was (it never merges into the message before it, §9.3). */
type Item = ({ role: "user"; text: string }
  | { role: "assistant"; text: string; tool_calls: ToolCall[]; reasoning?: string; reasoning_opaque?: Json }
  | { role: "tool"; slot: Slot }
  | { role: "tool"; call_id: string; tool: string; text: string }) & { kept?: boolean };

const joined = (parts: string[]) => parts.map((p) => `\n\n${p}`).join("");

/** The messages the items make (§9.3): tool messages built, user contributions in a row merged. */
function messagesOf(items: Item[]): (Message & { kept?: boolean })[] {
  const messages: (Message & { kept?: boolean })[] = [];
  for (const item of items) {
    let message: Message & { kept?: boolean };
    if (item.role === "tool" && "slot" in item) {
      const s = item.slot;
      const body = s.denied ?? s.replaced ?? s.result;
      if (body === undefined) continue; // the call never finished
      message = { role: "tool", call_id: s.call_id, tool: s.tool, text: s.modifies.map((m) => `${m}\n`).join("") + body + joined(s.contexts) };
    } else message = { ...item } as Message & { kept?: boolean };
    const last = messages.at(-1);
    if (message.role === "user" && last?.role === "user" && !message.kept) last.text += `\n\n${message.text}`;
    else messages.push(message);
  }
  return messages;
}

export function render(harness: Harness, entries: readonly Entry[], scope: Scope): Request {
  const toolError = harness.texts?.tool_error;
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
      // A call's `malformed` text is the log's record; the request carries what goes back (§9.4).
      const calls = (e.tool_calls as LoggedCall[]).map(({ malformed: _, ...call }) => call);
      items.push({ // the adapter decides whether the reasoning goes back (§9)
        role: "assistant", text: e.text as string, tool_calls: calls,
        ...(e.reasoning !== undefined && { reasoning: e.reasoning as string }),
        ...(e.reasoning_opaque !== undefined && { reasoning_opaque: e.reasoning_opaque as Json }),
      });
      for (const c of calls) {
        const slot: Slot = { call_id: c.call_id, tool: c.tool, modifies: [], contexts: [] };
        slots.set(c.call_id, slot);
        items.push({ role: "tool", slot });
      }
    } else if (e.type === "tool_result") {
      const slot = slots.get(e.call_id as string);
      if (slot) slot.result = e.ok ? resultText(true, e.result as Json) : resultText(false, e.error as Json, toolError);
    } else if (e.type === "hook") {
      const event = e.event as string;
      const decision = e.decision as string;
      const text = decision === "modify" ? ((e.text as string | undefined) ?? "args changed") : (e.text as string);
      const wrapper = text === undefined ? "" : e.wrap === false ? text : hookWrapper(event, e.hook as string, decision, text);
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
        // The newest `keep` messages stay as they were; the text replaces the ones before them.
        const keep = (e.keep as number | undefined) ?? 0;
        const kept = keep > 0 ? messagesOf(items).slice(-keep).map((m) => ({ ...m, kept: true })) : [];
        items = [{ role: "user", text: wrapper }, ...kept];
      } else if ((event === "pre_request" || event === "stop") && (decision === "add_context" || decision === "continue")) {
        items.push({ role: "user", text: wrapper });
      }
    }
  }

  const messages = messagesOf(items).map(({ kept: _, ...m }) => m as Message);
  const declared = harness.tools ?? {};
  const tools = toolIds(harness).map((name) => ({ name, ...shownTool(name, declared[name]!) }));
  return { system, tools, messages };
}
