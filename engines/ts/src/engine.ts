// The run loop (spec §8), hooks (§5, §6) and child runs (§10).
import { SPAWN_INPUT, harnessErrors, type Event, type Harness, type Hook, type Limits } from "./harness.js";
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
  /** A replacement harness to take at this step boundary, or null (§12.3). */
  harness?(step: number): unknown;
}

export class InfraFailure extends Error {}

type LimitName = "max_steps" | "max_tool_calls" | "max_depth" | "max_continues" | "max_hook_text";
type Effective = Record<LimitName, number>;
const LIMITS: LimitName[] = ["max_steps", "max_tool_calls", "max_depth", "max_continues", "max_hook_text"];
const DEFAULTS: Effective = { max_steps: 1000, max_tool_calls: 1000, max_depth: 1, max_continues: 3, max_hook_text: 4000 };

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
/** A hook with the run whose harness declared it (inherited hooks keep their harness, §10). */
interface Owned { hook: Hook; owner: Run }
type Reason = "stop" | "limit" | "infra_failure";

class Ended extends Error {
  constructor(readonly reason: "stop" | "limit") {
    super(reason);
  }
}

/** Run a validated harness to its end and return the log. */
export async function run(harness: Harness, host: Host): Promise<Log> {
  const log = new Log();
  await new Run(harness, host, log, TOP, topLimits(harness), { step: 0 }, undefined, []).run(null);
  return log;
}

function topLimits(harness: Harness): Effective {
  return Object.fromEntries(LIMITS.map((n) => [n, harness.limits?.[n] ?? DEFAULTS[n]])) as Effective;
}

const SOURCE = /^[a-zA-Z0-9_-]{1,64}$/;

class Run {
  /** Requests and tool calls of this run and its children (§8, §10). */
  stepsUsed = 0;
  toolCallsUsed = 0;
  lastText = "";
  schemas = new Map<string, Check>();

  constructor(
    public harness: Harness,
    readonly host: Host,
    readonly log: Log,
    readonly scope: Scope,
    public limits: Effective,
    /** The current step (§8), shared by every run in the log. */
    readonly counter: { step: number },
    readonly parent: Run | undefined,
    readonly inherited: Owned[],
  ) {
    this.compile();
  }

  private compile(): void {
    this.schemas = new Map();
    for (const [id, t] of Object.entries(this.harness.tools ?? {})) {
      if (id === "core_spawn") this.schemas.set("tools.core_spawn.input", compileSchema(SPAWN_INPUT));
      if (t.input) this.schemas.set(`tools.${id}.input`, compileSchema(t.input));
      if (t.output) this.schemas.set(`tools.${id}.output`, compileSchema(t.output));
    }
    for (const [id, h] of Object.entries(this.harness.handlers ?? {})) {
      if (h.input) this.schemas.set(`handlers.${id}.input`, compileSchema(h.input));
    }
  }

  get step(): number {
    return this.counter.step;
  }

  get hooks(): Owned[] {
    return [...this.inherited, ...(this.harness.hooks ?? []).map((hook) => ({ hook, owner: this as Run }))];
  }

  append(type: string, members: { [member: string]: Json }) {
    return this.log.append(this.scope, type, members);
  }

  /** Run to the end. A child's only user message is its task; the top level asks the host. */
  async run(task: string | null): Promise<Reason> {
    this.append("run_start", { harness_hash: await hash(this.harness), depth: this.scope.depth });
    let reason: Reason;
    try {
      await this.start();
      let pending = task;
      for (;;) {
        const text = this.parent ? pending : await this.host.user();
        pending = null;
        if (text === null) throw new Ended("stop");
        const decisions = await this.chain("user_prompt", { message: text });
        if (decisions.some((d) => d.decision === "deny")) continue;
        this.append("user", { text });
        await this.turn();
      }
    } catch (e) {
      if (e instanceof Ended) reason = e.reason;
      else if (e instanceof InfraFailure) reason = "infra_failure";
      else throw e;
    }
    this.append("run_end", { reason });
    return reason;
  }

  /** Run the `session_start` hooks and log the assembled system prompt (§9.1). */
  private async start(): Promise<void> {
    const contexts = await this.chain("session_start", {});
    const system = this.harness.prompt
      + contexts.map((d) => `\n\n${hookWrapper("session_start", d.hook.id, d.decision, d.text!)}`).join("");
    this.append("system", { text: system });
  }

  /** The top-level step boundary (§8 step 3.1): a replacement harness, then queued interrupts. */
  private async boundary(): Promise<void> {
    const next = this.host.harness?.(this.step);
    if (next !== undefined && next !== null) {
      let valid: boolean;
      try {
        canonical(next);
        valid = harnessErrors(next).length === 0;
      } catch {
        valid = false;
      }
      if (!valid) throw new InfraFailure("the host's replacement harness is not valid");
      this.harness = next as Harness;
      this.limits = topLimits(this.harness);
      this.compile();
      this.append("harness_changed", { harness_hash: await hash(this.harness) });
      await this.start();
    }
    for (const interrupt of this.host.interrupts(this.step)) {
      if (!isObject(interrupt) || typeof interrupt.source !== "string" || !SOURCE.test(interrupt.source)
        || typeof interrupt.text !== "string" || !isJson(interrupt.text)) {
        throw new InfraFailure("malformed interrupt");
      }
      const { source, text } = interrupt;
      const decisions = await this.chain("interrupt", { interrupt: { source, text } });
      if (decisions.some((d) => d.decision === "deny")) continue;
      this.append("interrupt", { source, text, step: this.step });
    }
  }

  private async turn(): Promise<void> {
    let continued = 0;
    for (;;) {
      if (this.stepsUsed === this.limits.max_steps) throw new Ended("limit");
      if (!this.parent) await this.boundary();
      await this.chain("pre_request", {});
      const response = checkResponse(await this.host.model(render(this.harness, this.log.entries, this.scope)));
      this.counter.step += 1;
      for (let r: Run | undefined = this; r; r = r.parent) r.stepsUsed += 1;
      const seq = this.log.entries.length + 1;
      const calls: ToolCall[] = (response.tool_calls ?? []).map((c, i) => ({ call_id: callId(seq, i), tool: c.tool, args: c.args }));
      this.lastText = response.text ?? "";
      this.append("assistant", {
        step: this.step,
        text: this.lastText,
        tool_calls: calls,
        ...(response.reasoning !== undefined && { reasoning: response.reasoning }),
        ...(response.reasoning_opaque !== undefined && { reasoning_opaque: response.reasoning_opaque }),
      });
      for (const call of calls) await this.toolCall(call);
      if (calls.length > 0) continue;
      if (continued < this.limits.max_continues) {
        const decisions = await this.chain("stop", { message: this.lastText, continued });
        if (decisions.some((d) => d.decision === "continue")) {
          continued += 1;
          continue;
        }
      }
      return;
    }
  }

  private async toolCall(call: ToolCall): Promise<void> {
    if (this.toolCallsUsed === this.limits.max_tool_calls) throw new Ended("limit");
    for (let r: Run | undefined = this; r; r = r.parent) r.toolCallsUsed += 1;
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
    const answer = call.tool === "core_spawn"
      ? await this.spawn(call, args as unknown as { harness: Harness; task: string })
      : checkAnswer(await this.host.call(call.tool, args), this.schemas.get(`tools.${call.tool}.output`));
    if (answer === null) return;
    this.result(call, answer);
    await this.chain("post_tool", { call: { tool: call.tool, args }, result: answer }, call);
  }

  private result(call: ToolCall, answer: Answer): void {
    this.append("tool_result", { call_id: call.call_id, tool: call.tool, ...answer });
  }

  /** `core_spawn` (§10): the narrowing check, then the child run. Null if the check denied it. */
  private async spawn(call: ToolCall, args: { harness: Harness; task: string }): Promise<Answer | null> {
    const child = args.harness;
    const denial = this.narrowing(child);
    if (denial !== null) {
      const text = excerpt(denial, this.limits.max_hook_text);
      this.append("hook", { hook: "core_spawn", event: "pre_tool", decision: "deny", text, call_id: call.call_id });
      return null;
    }
    const limits = Object.fromEntries(LIMITS.map((n) => [n, child.limits?.[n] ?? this.allowance(n)])) as Effective;
    const scope = { depth: this.scope.depth + 1, parent_call: call.call_id };
    const run = new Run(child, this.host, this.log, scope, limits, this.counter, this, this.hooks);
    if ((await run.run(args.task)) === "infra_failure") throw new InfraFailure("the child run failed");
    return { ok: true, result: { text: run.lastText, steps: run.stepsUsed, tool_calls: run.toolCallsUsed } };
  }

  /** How much of a limit a child may have: what is left of a budget, else the limit itself. */
  private allowance(name: LimitName): number {
    if (name === "max_steps") return this.limits.max_steps - this.stepsUsed;
    if (name === "max_tool_calls") return this.limits.max_tool_calls - this.toolCallsUsed;
    return this.limits[name];
  }

  /** The first failed narrowing check's text (§10), or null if the child may run. */
  private narrowing(child: Harness): string | null {
    let valid: boolean;
    try {
      canonical(child);
      valid = harnessErrors(child).length === 0;
    } catch {
      valid = false;
    }
    if (!valid) return "child harness is not valid";
    const tools = this.harness.tools ?? {};
    const childTools = child.tools ?? {};
    for (const id of Object.keys(childTools).sort()) {
      if (!Object.hasOwn(tools, id)) return `child tool ${id} is not a parent tool`;
      if (canonical(childTools[id]!.input ?? null) !== canonical(tools[id]!.input ?? null)) {
        return `child tool ${id} has a different input schema`;
      }
    }
    for (const id of Object.keys(child.handlers ?? {}).sort()) {
      if (!Object.hasOwn(this.harness.handlers ?? {}, id)) return `child handler ${id} is not a parent handler`;
    }
    for (const name of LIMITS) {
      const declared = child.limits?.[name];
      if (declared !== undefined && declared > this.allowance(name)) {
        return `child limit ${name} exceeds the parent's ${canonical(this.allowance(name))}`;
      }
    }
    if (Object.hasOwn(childTools, "core_spawn") && !(this.scope.depth + 1 < this.limits.max_depth)) {
      return `child at depth ${this.scope.depth + 1} may not spawn`;
    }
    return null;
  }

  /** Run the hooks of an event in order (§5.2), log each decision, and return the ones that act. */
  private async chain(event: Event, members: Members, call?: ToolCall): Promise<Decision[]> {
    const acting: Decision[] = [];
    let current = members.call;
    let replaced: string | undefined;
    const key = call?.tool ?? members.interrupt?.source;
    for (const { hook, owner } of this.hooks) {
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

      const d = await this.decide(hook, owner, event, input, current?.tool);
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
  private async decide(hook: Hook, owner: Run, event: Event, input: { [k: string]: Json }, tool?: string): Promise<Decision | null> {
    const cap = (text: string) => excerpt(text, this.limits.max_hook_text);
    if (hook.run.startsWith("core_")) {
      const w = hook.with ?? {};
      if (hook.run === "core_context") return { hook, decision: "add_context", text: cap(w.text as string) };
      const failure = check(hook.run, w, this.step, input.view as ViewEntry[]);
      return failure === null ? { hook, decision: "allow" } : { hook, decision: PUSH_BACK[event]!, text: cap(failure) };
    }
    const schema = owner.schemas.get(`handlers.${hook.run}.input`);
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
