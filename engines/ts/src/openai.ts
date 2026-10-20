// OpenAI-compatible Chat Completions adapter (host side, spec §9, §13): the neutral request to the
// API, the API's answer back to a model response. Texts pass through unchanged; tools keep their ids.
// The twin of engines/py/fausth/openai.py; conformance/openai.json pins both.
import { InfraFailure } from "./engine.js";
import type { Request } from "./render.js";
import { canonical, type Json } from "./values.js";

type Obj = { [k: string]: Json };
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
// Gateways that answer 400 for their own trouble (KIT: "ServiceUnavailable", "Server Connection Error").
const TRANSIENT = ["unavailable", "connection error", "overloaded", "try again", "timeout", "bad gateway"];
export const REASONING_REPLAY = ["none", "turn", "all"] as const;
export type ReasoningReplay = (typeof REASONING_REPLAY)[number];

/** The Chat Completions body for a neutral request. `reasoningReplay` says which logged reasoning goes back as
 * `reasoning_content` (§9): none, the current turn's (after the last user message), or all of it. */
export function toChat(request: Request, model: string, extra: Obj = {}, reasoningReplay: ReasoningReplay = "none"): Obj {
  if (!REASONING_REPLAY.includes(reasoningReplay)) throw new Error(`reasoning_replay must be one of ${REASONING_REPLAY.join(", ")}`);
  const lastUser = request.messages.findLastIndex((m) => m.role === "user");
  const messages: Obj[] = request.system ? [{ role: "system", content: request.system }] : [];
  for (const [i, m] of request.messages.entries()) {
    if (m.role === "user") messages.push({ role: "user", content: m.text });
    else if (m.role === "assistant") {
      const message: Obj = { role: "assistant", content: m.text || m.tool_calls.length === 0 ? m.text : null };
      if (m.tool_calls.length > 0) {
        message.tool_calls = m.tool_calls.map((c) => ({
          id: c.call_id, type: "function", function: { name: c.tool, arguments: canonical(c.args) },
        }));
      }
      if (m.reasoning && (reasoningReplay === "all" || (reasoningReplay === "turn" && i > lastUser))) message.reasoning_content = m.reasoning;
      messages.push(message);
    } else messages.push({ role: "tool", tool_call_id: m.call_id, content: m.text });
  }
  const body: Obj = { model, messages };
  if (request.tools.length > 0) {
    body.tools = request.tools.map((t) => ({
      type: "function", function: { name: t.name, description: t.description, parameters: t.input },
    }));
  }
  return { ...body, ...extra };
}

const isObject = (v: unknown): v is { [k: string]: unknown } => typeof v === "object" && v !== null && !Array.isArray(v);

/** The model response (spec §14 shape) for a Chat Completions answer. Throws InfraFailure. */
export function fromChat(body: unknown, provider: string): Obj {
  const choices = isObject(body) ? body.choices : undefined;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  if (!isObject(first) || !isObject(first.message)) throw new InfraFailure("the answer has no message");
  const message = first.message;
  const out: Obj = { text: typeof message.content === "string" ? message.content : "" };
  const calls: Obj[] = [];
  for (const c of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const f = isObject(c) && isObject(c.function) ? c.function : {};
    const raw = f.arguments;
    let args: Json;
    if (raw === undefined || raw === null || raw === "") args = {};
    else if (typeof raw === "string") {
      try {
        args = JSON.parse(raw) as Json;
      } catch {
        args = raw; // not JSON: the engine answers "invalid arguments" to the model
      }
    } else args = raw as Json;
    calls.push({ tool: f.name as Json, args });
  }
  if (calls.length > 0) out.tool_calls = calls;
  const reasoning = message.reasoning_content || message.reasoning;
  if (typeof reasoning === "string" && reasoning) out.reasoning = reasoning;
  if (message.reasoning_details) out.reasoning_opaque = { provider, data: message.reasoning_details as Json };
  return out;
}

export interface ChatOptions {
  extra?: Obj; timeoutMs?: number; retries?: number; headers?: Record<string, string>; reasoningReplay?: ReasoningReplay;
}

/** A model transport for one OpenAI-compatible endpoint and model. Retries transient failures (the
 * binding's job, §5.4); anything left is an infrastructure failure. */
export class ChatModel {
  readonly url: string;

  constructor(base: string, readonly apiKey: string, readonly model: string, readonly provider: string, readonly options: ChatOptions = {}) {
    this.url = `${base.replace(/\/+$/, "")}/chat/completions`;
  }

  async call(request: Request): Promise<Obj> {
    const body = JSON.stringify(toChat(request, this.model, this.options.extra, this.options.reasoningReplay));
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}`, ...this.options.headers };
    const retries = this.options.retries ?? 3;
    for (let attempt = 0; ; attempt += 1) {
      const last = attempt === retries;
      let problem: string;
      try {
        const response = await fetch(this.url, { method: "POST", headers, body, signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000) });
        const text = await response.text();
        if (response.ok) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            throw new InfraFailure(`${this.model}: the answer is not JSON`);
          }
          return fromChat(parsed, this.provider);
        }
        problem = `HTTP ${response.status} from ${this.model}: ${text.slice(0, 300)}`;
        const transient = RETRY_STATUS.has(response.status)
          || (response.status === 400 && TRANSIENT.some((t) => text.toLowerCase().includes(t)));
        if (!transient) throw new InfraFailure(problem);
      } catch (e) {
        if (e instanceof InfraFailure) throw e;
        problem = `${this.model}: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (last) throw new InfraFailure(problem);
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}
