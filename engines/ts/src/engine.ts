// The run loop (spec §8) and hooks (§5, §6).
import type { Event, Harness, Hook, Limits } from "./harness.js";
import { Log, TOP, callId, view, type Scope, type ViewEntry } from "./log.js";
import { hookWrapper, render, type Request, type ToolCall } from "./render.js";
import { compileSchema, type Check } from "./schema.js";
import { canonical, excerpt, hash, type Json } from "./values.js";

export interface ModelResponse {
  text?: string;
  tool_calls?: { tool: string; args: Json }[];
  reasoning?: string;
  reasoning_opaque?: Json;
}
export type Answer = { ok: true; result: Json } | { ok: false; error: string };
export interface Interrupt { source: string; text: string }

/** What the engine needs from a host (§13). Methods throw InfraFailure when they can't answer. */
export interface Host {
  /** The next user message, or null when the conversation is over. */
  user(): Promise<string | null>;
  model(request: Request): Promise<unknown>;
  /** Call the binding of a tool or handler; the answer is checked by the engine (§3.3). */
  call(id: string, input: Json): Promise<unknown>;
  /** Interrupts queued for delivery at this step boundary, in arrival order (§11). */
  interrupts(step: number): Interrupt[];
}

export class InfraFailure extends Error {}

const DEFAULTS: Required<Omit<Limits, "timeout_ms">> = {
  max_steps: 1000, max_tool_calls: 1000, max_depth: 1, max_continues: 3, max_hook_text: 4000,
};

/** Decisions each event allows besides `allow` (§4), and what a failed built-in check becomes (§6). */
const ALLOWED: Record<Event, string[]> = {
  session_start: ["add_context"],
  user_prompt: ["deny", "add_context"],
  pre_request: ["replace_context", "add_context"],
  pre_tool: ["deny", "modify", "add_context"],
  post_tool: ["replace", "add_context"],
  stop: ["continue", "add_context"],
  interrupt: ["deny", "add_context"],
};
const PUSH_BACK: Partial<Record<Event, string>> = {
  pre_tool: "deny", user_prompt: "deny", interrupt: "deny", stop: "continue", post_tool: "add_context",
};
const ENDS_CHAIN = new Set(["deny", "continue", "replace_context"]);

interface Decision { hook: Hook; decision: string; text?: string; args?: Json }
interface Members { call?: { tool: string; args: Json }; result?: Answer; message?: string; interrupt?: Interrupt; continued?: number }

class Ended extends Error {
  constructor(readonly reason: "stop" | "limit") {
    super(reason);
  }
}

/** Run a validated harness to its end and return the log. */
export async function run(harness: Harness, host: Host): Promise<Log> {
  const log = new Log();
  await new Run(harness, host, log, TOP).run();
  return log;
}

class Run {
  /** The current step (§8): model requests made so far. */
  step = 0;
  toolCalls = 0;
  private schemas = new Map<string, Check>();

  constructor(readonly harness: Harness, readonly host: Host, readonly log: Log, readonly scope: Scope) {
    for (const [id, t] of Object.entries(harness.tools ?? {})) {
      if (t.input) this.schemas.set(`tools.${id}.input`, compileSchema(t.input));
      if (t.output) this.schemas.set(`tools.${id}.output`, compileSchema(t.output));
    }
    for (const [id, h] of Object.entries(harness.handlers ?? {})) {
      if (h.input) this.schemas.set(`handlers.${id}.input`, compileSchema(h.input));
    }
  }

  limit(name: keyof typeof DEFAULTS): number {
    return this.harness.limits?.[name] ?? DEFAULTS[name];
  }

  append(type: string, members: { [member: string]: Json }) {
    return this.log.append(this.scope, type, members);
  }

  async run(): Promise<void> {
    this.append("run_start", { harness_hash: await hash(this.harness), depth: this.scope.depth });
    try {
      const contexts = await this.chain("session_start", {});
      const system = this.harness.prompt
        + contexts.map((d) => `\n\n${hookWrapper("session_start", d.hook.id, d.decision, d.text!)}`).join("");
      this.append("system", { text: system });
      for (;;) {
        const text = await this.host.user();
        if (text === null) throw new Ended("stop");
        const decisions = await this.chain("user_prompt", { message: text });
        if (decisions.some((d) => d.decision === "deny")) continue;
        this.append("user", { text });
        await this.turn();
      }
    } catch (e) {
      if (e instanceof Ended) this.append("run_end", { reason: e.reason });
      else if (e instanceof InfraFailure) this.append("run_end", { reason: "infra_failure" });
      else throw e;
    }
  }

  private async turn(): Promise<void> {
    let continued = 0;
    for (;;) {
      if (this.step === this.limit("max_steps")) throw new Ended("limit");
      await this.chain("pre_request", {});
      const response = checkResponse(await this.host.model(render(this.harness, this.log.entries, this.scope)));
      this.step += 1;
      const seq = this.log.entries.length + 1;
      const calls: ToolCall[] = (response.tool_calls ?? []).map((c, i) => ({ call_id: callId(seq, i), tool: c.tool, args: c.args }));
      const text = response.text ?? "";
      this.append("assistant", {
        step: this.step,
        text,
        tool_calls: calls,
        ...(response.reasoning !== undefined && { reasoning: response.reasoning }),
        ...(response.reasoning_opaque !== undefined && { reasoning_opaque: response.reasoning_opaque }),
      });
      for (const call of calls) await this.toolCall(call);
      if (calls.length > 0) continue;
      if (continued < this.limit("max_continues")) {
        const decisions = await this.chain("stop", { message: text, continued });
        if (decisions.some((d) => d.decision === "continue")) {
          continued += 1;
          continue;
        }
      }
      return;
    }
  }

  private async toolCall(call: ToolCall): Promise<void> {
    if (this.toolCalls === this.limit("max_tool_calls")) throw new Ended("limit");
    this.toolCalls += 1;
    if (!Object.hasOwn(this.harness.tools ?? {}, call.tool)) {
      this.result(call, { ok: false, error: "invalid arguments: unknown tool" });
      return;
    }
    if (!this.schemas.get(`tools.${call.tool}.input`)!(call.args)) {
      this.result(call, { ok: false, error: "invalid arguments: does not match the input schema" });
      return;
    }
    const pre = await this.chain("pre_tool", { call: { tool: call.tool, args: call.args } }, call);
    if (pre.some((d) => d.decision === "deny")) return;
    const args = pre.filter((d) => d.decision === "modify").at(-1)?.args ?? call.args;
    const answer = checkAnswer(await this.host.call(call.tool, args), this.schemas.get(`tools.${call.tool}.output`));
    this.result(call, answer);
    await this.chain("post_tool", { call: { tool: call.tool, args }, result: answer }, call);
  }

  private result(call: ToolCall, answer: Answer): void {
    this.append("tool_result", { call_id: call.call_id, tool: call.tool, ...answer });
  }

  /** Run the hooks of an event in order (§5.2), log each decision, and return the ones that act. */
  private async chain(event: Event, members: Members, call?: ToolCall): Promise<Decision[]> {
    const acting: Decision[] = [];
    let current = members.call;
    let replaced: string | undefined;
    const key = call?.tool ?? members.interrupt?.source;
    for (const hook of this.harness.hooks ?? []) {
      if (hook.on !== event || !matches(hook.match, key)) continue;
      const input: { [k: string]: Json } = {
        event, hook: hook.id, with: hook.with ?? {}, step: this.step, view: view(this.log.entries, this.scope) as Json,
      };
      if (current) input.call = current;
      if (members.result) input.result = members.result;
      if (replaced !== undefined) input.replaced = replaced;
      if (members.message !== undefined) input.message = members.message;
      if (members.interrupt) input.interrupt = { ...members.interrupt };
      if (members.continued !== undefined) input.continued = members.continued;
      if (event === "pre_request") input.context = render(this.harness, this.log.entries, this.scope).messages as Json;

      const d = await this.decide(hook, event, input, current?.tool);
      const where: { [k: string]: Json } = call ? { call_id: call.call_id } : {};
      if (d === null) {
        this.append("hook", { hook: hook.id, event, decision: "failed", ...where });
        if ((hook.on_failure ?? "end") === "end") throw new InfraFailure(`hook ${hook.id} failed`);
        continue;
      }
      this.append("hook", {
        hook: hook.id, event, decision: d.decision,
        ...(d.text !== undefined && { text: d.text }), ...(d.args !== undefined && { args: d.args }), ...where,
      });
      if (d.decision === "allow") continue;
      acting.push(d);
      if (d.decision === "modify") current = { tool: current!.tool, args: d.args! };
      if (d.decision === "replace") replaced = d.text;
      if (ENDS_CHAIN.has(d.decision)) break;
    }
    return acting;
  }

  /** One hook's decision (§5.4), or null if the hook failed. */
  private async decide(hook: Hook, event: Event, input: { [k: string]: Json }, tool?: string): Promise<Decision | null> {
    const cap = (text: string) => excerpt(text, this.limit("max_hook_text"));
    if (hook.run.startsWith("core_")) {
      const w = hook.with ?? {};
      if (hook.run === "core_context") return { hook, decision: "add_context", text: cap(w.text as string) };
      const failure = check(hook.run, w, this.step, input.view as ViewEntry[]);
      return failure === null ? { hook, decision: "allow" } : { hook, decision: PUSH_BACK[event]!, text: cap(failure) };
    }
    const schema = this.schemas.get(`handlers.${hook.run}.input`);
    if (schema && !schema(input)) return null;
    let answer: unknown;
    try {
      answer = await this.host.call(hook.run, input);
    } catch (e) {
      if (e instanceof InfraFailure) return null;
      throw e;
    }
    if (!isObject(answer) || answer.ok !== true || Object.keys(answer).length !== 2 || !isObject(answer.result)) return null;
    const out = answer.result;
    const decision = out.decision;
    if (typeof decision !== "string" || (decision !== "allow" && !ALLOWED[event].includes(decision))) return null;
    const members = Object.keys(out).filter((k) => k !== "decision").sort().join(",");
    if (decision === "allow") return members === "" ? { hook, decision } : null;
    if (decision === "modify") {
      if (members !== "args" && members !== "args,text") return null;
      if (out.text !== undefined && typeof out.text !== "string") return null;
      if (!isJson(out.args) || !this.schemas.get(`tools.${tool}.input`)!(out.args)) return null;
      return { hook, decision, args: out.args as Json, ...(out.text !== undefined && { text: cap(out.text as string) }) };
    }
    if (members !== "text" || typeof out.text !== "string" || !isJson(out.text)) return null;
    return { hook, decision, text: cap(out.text) };
  }
}

function matches(match: string | string[] | undefined, key: string | undefined): boolean {
  if (match === undefined || match === "*") return true;
  return key !== undefined && (Array.isArray(match) ? match.includes(key) : match === key);
}

type Call = Extract<ViewEntry, { tool: string }>;

/** A built-in check (§6): null if it passes, else the failure text. */
function check(run: string, w: { [k: string]: Json }, step: number, entries: ViewEntry[]): string | null {
  const calls = entries.filter((e): e is Call => "tool" in e);
  const successful = (tool: Json) => (e: Call) => e.tool === tool && e.ok;
  const seen = (e: Call) => e.step < step;
  if (run === "core_called_since") {
    const since = w.since === undefined ? -1 : calls.findLastIndex(successful(w.since));
    if (calls.slice(since + 1).some((e) => successful(w.tool!)(e) && seen(e))) return null;
    return since >= 0 ? `${w.tool} not called since the last ${w.since}` : `${w.tool} not called yet`;
  }
  if (run === "core_last_result") {
    const last = calls.filter((e) => successful(w.tool!)(e) && seen(e)).at(-1);
    if (last === undefined || !last.ok) return `${w.tool} has no successful call yet`;
    const value = at(last.result, w.path as string);
    return value !== undefined && canonical(value) === canonical(w.eq) ? null : `last ${w.tool} result ${w.path} is not ${canonical(w.eq)}`;
  }
  if (run === "core_count") {
    return calls.filter(successful(w.tool!)).length < (w.max as number) ? null : `${w.tool} limit reached (${canonical(w.max)})`;
  }
  return w.text as string; // core_deny
}

/** The value at a `.`-separated path of member names and array indexes (§6); undefined if none. */
function at(value: Json, path: string): Json | undefined {
  if (path === "") return value;
  let v: Json | undefined = value;
  for (const segment of path.split(".")) {
    if (Array.isArray(v) && /^(0|[1-9][0-9]*)$/.test(segment)) v = v[Number(segment)];
    else if (isObject(v) && Object.hasOwn(v, segment)) v = v[segment] as Json;
    else return undefined;
  }
  return v;
}

const isObject = (v: unknown): v is { [k: string]: unknown } => typeof v === "object" && v !== null && !Array.isArray(v);

/** A model response as the transport delivered it; anything else breaks the interface. */
function checkResponse(v: unknown): ModelResponse {
  const ok = isObject(v)
    && (v.text === undefined || typeof v.text === "string")
    && (v.reasoning === undefined || typeof v.reasoning === "string")
    && (v.tool_calls === undefined || (Array.isArray(v.tool_calls)
      && v.tool_calls.every((c) => isObject(c) && typeof c.tool === "string" && "args" in c)));
  if (!ok || !isJson(v)) throw new InfraFailure("malformed model response");
  return v as ModelResponse;
}

/** A binding's answer (§3.3): `{ok: true, result}` or `{ok: false, error}`, nothing else. */
function checkAnswer(v: unknown, output: Check | undefined): Answer {
  if (isObject(v) && v.ok === true && Object.keys(v).length === 2 && "result" in v && isJson(v.result)) {
    if (output && !output(v.result)) throw new InfraFailure("result fails the output schema");
    return { ok: true, result: v.result as Json };
  }
  if (isObject(v) && v.ok === false && Object.keys(v).length === 2 && typeof v.error === "string" && isJson(v.error)) {
    return { ok: false, error: v.error };
  }
  throw new InfraFailure("malformed binding answer");
}

function isJson(v: unknown): boolean {
  try {
    canonical(v);
    return true;
  } catch {
    return false;
  }
}
