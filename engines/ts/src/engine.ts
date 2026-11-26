// The run loop (spec §8), hooks (§5, §6) and child runs (§10).
import {
  SPAWN_INPUT, TEXTS, TURN, fill, harnessErrors, harnessHash, type Event, type Harness, type Hook, type TextName,
} from "./harness.js";
import { Log, TOP, callId, inScope, view, type Scope, type ViewEntry } from "./log.js";
import { argsText, hookWrapper, render, type LoggedCall, type Request } from "./render.js";
import { argumentReasons, compileSchema, type Check } from "./schema.js";
import { argumentText, canonical, excerpt, sortedAsciiText, type Json } from "./values.js";

/** A tool call as the model response gives it (§14): its arguments, with the model's text for them (`raw`), or
 * the text that wasn't JSON. */
export type ResponseCall =
  | { tool: string; args: Json; raw?: string; call_id?: string }
  | { tool: string; malformed: string; parse_error?: string; call_id?: string };
export interface ModelResponse {
  text?: string;
  tool_calls?: ResponseCall[];
  reasoning?: string;
  reasoning_opaque?: Json;
  usage?: { [k: string]: Json };
  /** Why the response ended, as the provider said it (§14). */
  finish?: string;
  /** The response failed: the provider rejected the request or the answer broke off (§14). */
  failure?: string;
}
export type Answer = { ok: true; result: Json } | { ok: false; error: string };
export interface Interrupt { source: string; text: string }

/** What the engine needs from a host (§13). Methods throw InfraFailure when they can't answer, and
 * HostEnd when the host ends the run (§8, §12.2). */
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
  /** Optional: the reasons text for arguments that failed a tool's input schema, from the host's own validator,
   * or null for the engine's (§8.1). After a pre_check `modify`, `args` are the modified ones. */
  reasons?(tool: string, args: Json): string | null | undefined;
}

export class InfraFailure extends Error {}
/** Thrown by a host to end the run (its user left, `timeout_ms` passed): `host_end` (§12.2). */
export class HostEnd extends Error {}

type LimitName = "max_steps" | "max_tool_calls" | "max_depth" | "max_continues" | "max_hook_text";
type Effective = Record<LimitName, number>;
const LIMITS: LimitName[] = ["max_steps", "max_tool_calls", "max_depth", "max_continues", "max_hook_text"];
const DEFAULTS: Effective = { max_steps: 1000, max_tool_calls: 1000, max_depth: 1, max_continues: 3, max_hook_text: 4000 };

/** Decisions each event allows besides `allow` (§4), and what a failed built-in check becomes (§6). */
const ALLOWED: Record<Event, string[]> = {
  session_start: ["add_context"],
  user_prompt: ["deny", "replace", "add_context"],
  pre_request: ["replace_context", "add_context"],
  post_response: ["modify", "retry", "end"],
  pre_check: ["modify"],
  pre_tool: ["deny", "modify", "add_context"],
  post_tool: ["replace", "add_context", "end"],
  stop: ["continue", "add_context"],
  interrupt: ["deny", "add_context"],
};
const PUSH_BACK: Partial<Record<Event, string>> = {
  pre_tool: "deny", user_prompt: "deny", interrupt: "deny", stop: "continue", post_tool: "add_context",
};
const ENDS_CHAIN = new Set(["deny", "continue", "replace_context", "retry", "end"]);
/** The members a `hook` entry logs when its decision has them (§7). */
const LOGGED = ["text", "args", "shown", "args_text", "calls", "keep", "wrap", "keep_reply", "replace_context"] as const;
/** What the response says beyond its text and calls, logged in the `assistant` entry as given (§7, §14). */
const RESPONSE_EXTRAS = ["reasoning", "reasoning_opaque", "usage", "finish", "failure"] as const;

type CallChange = { call_id: string; tool: string };
interface Decision {
  hook: Hook; decision: string; text?: string; args?: Json; keep?: number; wrap?: boolean;
  shown?: "model" | "modified"; args_text?: string; calls?: CallChange[]; keep_reply?: boolean;
  replace_context?: { text: string; keep?: number; wrap?: boolean };
  /** A pre_check hook's own `args_text`, as it gave it (not logged as such). */
  given?: string;
}
type ReplyCall = LoggedCall & { raw?: string };
interface Reply { text: string; tool_calls: ReplyCall[]; [k: string]: Json | undefined }
interface Members {
  call?: { tool: string; args: Json; raw?: string; malformed?: string }; result?: Answer; message?: string;
  interrupt?: Interrupt; continued?: number; reply?: Reply; context?: Json[];
}
/** A hook with the run whose harness declared it (inherited hooks keep their harness, §10). */
interface Owned { hook: Hook; owner: Run }
type Reason = "stop" | "limit" | "infra_failure" | "host_end" | "harness_end";

class Ended extends Error {
  constructor(readonly reason: "stop" | "limit" | "harness_end") {
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
/** The form of the engine's own call ids (§7), which a provider's id may not take. */
const ENGINE_ID = /^c[0-9]+-[0-9]+$/;

class Run {
  /** Requests and tool calls of this run and its children (§8, §10). */
  stepsUsed = 0;
  toolCallsUsed = 0;
  lastText = "";
  /** The step at which this run's latest user message was admitted (§5.3). */
  turn = 0;
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

  /** A call's argument text in this run's harness's form (§9.4), compact or indented. */
  argumentText(call: { args: Json; raw?: string }, indented = false): string {
    const form = this.harness.argument_text ?? "model_order";
    if (form === "sorted_ascii") return sortedAsciiText(call.raw ?? argumentText(call.args), indented);
    if (form === "as_sent" && !indented && call.raw !== undefined) return call.raw;
    return argumentText(call.args, indented);
  }

  /** The argument text of arguments a `pre_check` hook modified (§5.4, §9.4): the hook's `args_text`, else the
   * arguments written as for a call without `raw`. */
  modifiedText(args: Json, given: string | undefined, indented = false): string {
    if (given === undefined) return this.argumentText({ args }, indented);
    return indented ? this.argumentText({ args, raw: given }, true) : given;
  }

  /** One of the engine's texts (§8.2): the harness's wording, else the default. */
  text(name: TextName, values: Record<string, string>): string {
    return fill(this.harness.texts?.[name] ?? TEXTS[name].default!, values);
  }

  get hooks(): Owned[] {
    return [...this.inherited, ...(this.harness.hooks ?? []).map((hook) => ({ hook, owner: this as Run }))];
  }

  append(type: string, members: { [member: string]: Json }) {
    return this.log.append(this.scope, type, members);
  }

  /** Run to the end. A child's only user message is its task; the top level asks the host. */
  async run(task: string | null): Promise<Reason> {
    this.append("run_start", { harness_hash: await harnessHash(this.harness), depth: this.scope.depth });
    let reason: Reason;
    try {
      await this.start();
      let pending = task;
      for (;;) {
        const text = this.parent ? pending : await this.host.user();
        pending = null;
        if (text === null) throw new Ended("stop");
        if (typeof text !== "string" || !isJson(text)) throw new InfraFailure("malformed user message");
        const decisions = await this.chain("user_prompt", { message: text });
        if (decisions.some((d) => d.decision === "deny")) continue;
        const replaced = decisions.filter((d) => d.decision === "replace").at(-1)?.text;
        this.append("user", { text: replaced ?? text });
        this.turn = this.step;
        await this.takeTurn();
      }
    } catch (e) {
      if (e instanceof Ended) reason = e.reason;
      else if (e instanceof InfraFailure) reason = "infra_failure";
      else if (e instanceof HostEnd) reason = "host_end";
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
      if (harnessErrors(next).length > 0) throw new InfraFailure("the host's replacement harness is not valid");
      this.harness = next as Harness;
      this.limits = topLimits(this.harness);
      this.compile();
      this.append("harness_changed", { harness_hash: await harnessHash(this.harness) });
      await this.start();
      if (this.stepsUsed >= this.limits.max_steps) throw new Ended("limit");
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

  private async takeTurn(): Promise<void> {
    let continued = 0;
    for (;;) {
      if (this.stepsUsed >= this.limits.max_steps) throw new Ended("limit");
      if (!this.parent) await this.boundary();
      await this.chain("pre_request", {});
      const request = render(this.harness, this.log.entries, this.scope);
      const response = checkResponse(await this.host.model(request));
      this.counter.step += 1;
      for (let r: Run | undefined = this; r; r = r.parent) r.stepsUsed += 1;
      const given = response.tool_calls ?? [];
      const calls = this.loggedCalls(given);
      this.lastText = response.text ?? "";
      const extras: { [k: string]: Json } = {};
      for (const k of RESPONSE_EXTRAS) if (response[k] !== undefined) extras[k] = response[k] as Json;
      this.append("assistant", { step: this.step, text: this.lastText, tool_calls: calls as Json, ...extras });
      // The reply as logged, each call with the model's `raw` text (§5.3); the request it answers.
      const { usage: _, ...replyExtras } = extras;
      const reply: Reply = {
        text: this.lastText,
        tool_calls: calls.map((c, i) => { const raw = (given[i] as { raw?: string }).raw; return raw === undefined ? c : { ...c, raw }; }),
        ...replyExtras,
      };
      const decisions = await this.chain("post_response", { reply, context: request.messages as Json[] });
      if (decisions.some((d) => d.decision === "end")) throw new Ended("harness_end");
      if (decisions.some((d) => d.decision === "retry")) continue;
      if (response.failure !== undefined) throw new InfraFailure("the model response failed and no post_response hook answered it");
      let pairs = calls.map((c, i) => [c, given[i]!] as const);
      const modified = decisions.filter((d) => d.decision === "modify").at(-1)?.calls;
      if (modified) {
        // Only the listed calls run, in that order, under their names (§5.4).
        const byId = new Map(pairs.map((p) => [p[0].call_id, p]));
        pairs = modified.map((m) => { const [c, r] = byId.get(m.call_id)!; return [{ ...c, tool: m.tool }, r] as const; });
      }
      for (const [call, r] of pairs) await this.toolCall(call, r);
      if (pairs.length > 0) continue;
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

  /** The response's calls as the log holds them (§7): ids, argument texts, malformed texts. */
  private loggedCalls(calls: ResponseCall[]): LoggedCall[] {
    const seq = this.log.entries.length + 1;
    const used = new Set<string>();
    for (const e of this.log.entries) {
      if (e.type === "assistant") for (const c of e.tool_calls as LoggedCall[]) used.add(c.call_id);
    }
    return calls.map((c, i) => {
      // The provider's id, unless it is empty, taken, or of the engine's form (§7).
      const given = c.call_id;
      const id = given && !used.has(given) && !ENGINE_ID.test(given) ? given : callId(seq, i);
      used.add(id);
      if ("malformed" in c) {
        // Its arguments go back as {} (§9.4).
        return { call_id: id, tool: c.tool, args: {}, malformed: c.malformed };
      }
      const text = this.argumentText(c); // written now, in the form of the harness that runs the call (§9.4)
      return { call_id: id, tool: c.tool, args: c.args, ...(text !== canonical(c.args) && { args_text: text }) };
    });
  }

  private async toolCall(call: LoggedCall, response: ResponseCall): Promise<void> {
    if (this.toolCallsUsed >= this.limits.max_tool_calls) throw new Ended("limit");
    for (let r: Run | undefined = this; r; r = r.parent) r.toolCallsUsed += 1;
    // the tool as the model named it, or as a post_response `modify` renamed it
    let shown = () => ({
      tool: call.tool, args: argsText(call),
      args_indented: this.argumentText("malformed" in response ? call : response, true),
    });
    if (!Object.hasOwn(this.harness.tools ?? {}, call.tool)) {
      this.result(call, { ok: false, error: this.text("unknown_tool", shown()) });
      return;
    }
    // Repair before the check (§5.4): the hooks see the model's text; the last `modify` gives the arguments.
    const raw = "raw" in response ? response.raw : undefined;
    const before = {
      tool: call.tool, args: call.args, ...(raw !== undefined && { raw }), ...(call.malformed !== undefined && { malformed: call.malformed }),
    };
    const repair = (await this.chain("pre_check", { call: before }, call)).filter((d) => d.decision === "modify").at(-1);
    let args = repair ? repair.args! : call.args;
    if (repair) {
      // The texts show the checked arguments, as `shown: modified` would (§8.2).
      const values = { tool: call.tool, args: this.modifiedText(args, repair.given), args_indented: this.modifiedText(args, repair.given, true) };
      shown = () => values;
    } else if (call.malformed !== undefined) {
      const parseError = ("parse_error" in response && response.parse_error) || "";
      this.result(call, { ok: false, error: this.text("malformed_arguments", { tool: call.tool, text: call.malformed, parse_error: parseError }) });
      return;
    }
    if (!this.schemas.get(`tools.${call.tool}.input`)!(args)) {
      const schema = call.tool === "core_spawn" ? SPAWN_INPUT : this.harness.tools![call.tool]!.input;
      const own = this.host.reasons?.(call.tool, args);
      if (own !== undefined && own !== null && (typeof own !== "string" || !isJson(own))) throw new InfraFailure("malformed reasons from the host");
      const reasons = own ?? argumentReasons(schema, args);
      this.result(call, { ok: false, error: this.text("invalid_arguments", { ...shown(), reasons }) });
      return;
    }
    const pre = await this.chain("pre_tool", { call: { tool: call.tool, args } }, call);
    if (pre.some((d) => d.decision === "deny")) return;
    args = pre.filter((d) => d.decision === "modify").at(-1)?.args ?? args;
    const answer = call.tool === "core_spawn"
      ? await this.spawn(call, args as unknown as { harness: Harness; task: string })
      : checkAnswer(await this.host.call(call.tool, args), this.schemas.get(`tools.${call.tool}.output`));
    if (answer === null) return;
    this.result(call, answer);
    const post = await this.chain("post_tool", { call: { tool: call.tool, args }, result: answer }, call);
    if (post.some((d) => d.decision === "end")) throw new Ended("harness_end"); // the reply's later calls don't run (§5.4)
  }

  private result(call: LoggedCall, answer: Answer): void {
    this.append("tool_result", { call_id: call.call_id, tool: call.tool, ...answer });
  }

  /** `core_spawn` (§10): the narrowing check, then the child run. Null if the check denied it. */
  private async spawn(call: LoggedCall, args: { harness: Harness; task: string }): Promise<Answer | null> {
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
    const reason = await run.run(args.task);
    if (reason === "infra_failure") throw new InfraFailure("the child run failed");
    if (reason === "host_end") throw new HostEnd("the host ended the run in a child");
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
    if (harnessErrors(child).length > 0) return "child harness is not valid";
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
  private async chain(event: Event, members: Members, call?: LoggedCall): Promise<Decision[]> {
    const acting: Decision[] = [];
    let current = members.call;
    let replaced: string | undefined;
    let message = members.message;
    let reply = members.reply;
    const key = call?.tool ?? members.interrupt?.source;
    for (const { hook, owner } of this.hooks) {
      if (hook.on !== event || !matches(hook.match, key)) continue;
      const input: { [k: string]: Json } = {
        event, hook: hook.id, with: hook.with ?? {}, step: this.step, turn: this.turn, view: view(this.log.entries, this.scope) as Json,
      };
      if (current) input.call = current;
      if (members.result) input.result = members.result;
      if (replaced !== undefined) input.replaced = replaced;
      if (message !== undefined) input.message = message;
      if (members.interrupt) input.interrupt = { ...members.interrupt };
      if (members.continued !== undefined) input.continued = members.continued;
      if (reply) input.reply = reply as unknown as Json;
      // The request's messages as they would be rendered now (§5.3); on post_response, the request the response answers.
      if (event === "pre_request" || event === "stop") input.context = render(this.harness, this.log.entries, this.scope).messages as Json;
      if (event === "post_response") input.context = members.context!;
      // The usage the run's last response reported (§5.3).
      if (event === "pre_request" || event === "stop" || event === "post_response") {
        const usage = this.log.entries.findLast((e) => e.type === "assistant" && inScope(e, this.scope))?.usage;
        if (usage !== undefined) input.usage = usage;
      }

      const ids = event === "post_response" ? members.reply!.tool_calls.map((c) => c.call_id) : undefined;
      const d = await this.decide(hook, owner, event, input, current?.tool, ids);
      const where: { [k: string]: Json } = call ? { call_id: call.call_id } : {};
      if (d === null) {
        this.append("hook", { hook: hook.id, event, decision: "failed", ...where });
        if ((hook.on_failure ?? "end") === "end") throw new InfraFailure(`hook ${hook.id} failed`);
        continue;
      }
      const logged: { [k: string]: Json } = {};
      for (const k of LOGGED) if (d[k] !== undefined) logged[k] = d[k] as Json;
      this.append("hook", { hook: hook.id, event, decision: d.decision, ...logged, ...where });
      if (d.decision === "allow") continue;
      acting.push(d);
      if (d.decision === "modify" && event === "post_response") {
        const originals = new Map(members.reply!.tool_calls.map((c) => [c.call_id, c]));
        reply = { ...reply!, tool_calls: d.calls!.map((c) => ({ ...originals.get(c.call_id)!, tool: c.tool })) };
      } else if (d.decision === "modify" && event === "pre_check") {
        current = { tool: current!.tool, args: d.args!, ...(current!.raw !== undefined && { raw: current!.raw }) };
      } else if (d.decision === "modify") current = { tool: current!.tool, args: d.args! };
      if (d.decision === "replace" && event === "user_prompt") message = d.text;
      else if (d.decision === "replace") replaced = d.text;
      if (ENDS_CHAIN.has(d.decision)) break;
    }
    return acting;
  }

  /** One hook's decision (§5.4), or null if the hook failed. */
  private async decide(hook: Hook, owner: Run, event: Event, input: { [k: string]: Json }, tool?: string, ids?: string[]): Promise<Decision | null> {
    const cap = (text: string) => excerpt(text, this.limits.max_hook_text);
    if (hook.run.startsWith("core_")) {
      const w = hook.with ?? {};
      if (hook.run === "core_context") return { hook, decision: "add_context", text: cap(w.text as string) };
      const failure = check(hook.run, w, this.step, this.turn, input.view as ViewEntry[]);
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
    if (decision === "modify" && event === "pre_check") return this.repair(hook, out, members);
    if (decision === "modify" && event === "post_response") return changedCalls(hook, out, members, ids ?? []);
    if (decision === "retry") return retry(hook, out, (input.context as Json[]).length, cap);
    if (decision === "end") {
      if (members !== "" && members !== "text") return null;
      if (out.text !== undefined && (typeof out.text !== "string" || !isJson(out.text))) return null;
      return { hook, decision, ...(out.text !== undefined && { text: cap(out.text as string) }) };
    }
    if (decision === "replace" && event === "user_prompt") {
      // The admitted message, whole (§5.4).
      if (members !== "text" || typeof out.text !== "string" || !isJson(out.text)) return null;
      return { hook, decision, text: out.text };
    }
    if (decision === "modify") {
      if (members !== "args" && members !== "args,text") return null;
      if (out.text !== undefined && typeof out.text !== "string") return null;
      if (!isJson(out.args) || !this.schemas.get(`tools.${tool}.input`)!(out.args)) return null;
      return { hook, decision, args: out.args as Json, ...(out.text !== undefined && { text: cap(out.text as string) }) };
    }
    if (decision === "replace_context" && members !== "text") {
      // Optional `keep` (at most the context's messages) and `wrap` (§5.4); unwrapped text is not excerpted.
      const names = members.split(",");
      if (!names.includes("text") || names.some((m) => m !== "text" && m !== "keep" && m !== "wrap")) return null;
      if (typeof out.text !== "string" || !isJson(out.text)) return null;
      const keep = out.keep;
      if (keep !== undefined && !(Number.isInteger(keep) && (keep as number) >= 0 && (keep as number) <= (input.context as Json[]).length)) return null;
      if (out.wrap !== undefined && typeof out.wrap !== "boolean") return null;
      return {
        hook, decision, text: out.wrap === false ? out.text : cap(out.text),
        ...(keep !== undefined && { keep: keep as number }), ...(out.wrap !== undefined && { wrap: out.wrap as boolean }),
      };
    }
    if (members !== "text" || typeof out.text !== "string" || !isJson(out.text)) return null;
    return { hook, decision, text: cap(out.text) };
  }

  /** A `pre_check` `modify` (§5.4): `args`, `shown` and, with `shown: modified`, an optional `args_text` that reads as
   * `args`. The arguments are checked against the schema afterwards, as any call's. */
  private repair(hook: Hook, out: { [k: string]: unknown }, members: string): Decision | null {
    if ((members !== "args,shown" && members !== "args,args_text,shown") || (out.shown !== "model" && out.shown !== "modified")) return null;
    if (!isJson(out.args)) return null;
    const given = out.args_text;
    if (given !== undefined && (out.shown !== "modified" || typeof given !== "string" || !isJson(given) || !reads(given, out.args))) return null;
    const args = out.args as Json;
    const d: Decision = { hook, decision: "modify", args, shown: out.shown, ...(given !== undefined && { given: given as string }) };
    if (out.shown === "modified") {
      const text = this.modifiedText(args, given as string | undefined);
      if (text !== canonical(args)) d.args_text = text;
    }
    return d;
  }
}

/** A `post_response` `modify` (§5.4): `calls`, a list of `{call_id, tool}` naming the reply's calls, none twice. */
function changedCalls(hook: Hook, out: { [k: string]: unknown }, members: string, ids: string[]): Decision | null {
  const calls = out.calls;
  if (members !== "calls" || !Array.isArray(calls) || !isJson(calls)) return null;
  const seen = new Set<string>();
  for (const c of calls) {
    if (!isObject(c) || Object.keys(c).sort().join(",") !== "call_id,tool" || typeof c.tool !== "string"
      || typeof c.call_id !== "string" || !ids.includes(c.call_id) || seen.has(c.call_id)) return null;
    seen.add(c.call_id);
  }
  return { hook, decision: "modify", calls: (calls as CallChange[]).map((c) => ({ call_id: c.call_id, tool: c.tool })) };
}

/** A `retry` (§5.4): optional `text`, `wrap`, `keep_reply` and a `replace_context` in that decision's shape. */
function retry(hook: Hook, out: { [k: string]: unknown }, context: number, cap: (text: string) => string): Decision | null {
  const names = Object.keys(out).filter((k) => k !== "decision");
  if (names.some((k) => !["text", "wrap", "keep_reply", "replace_context"].includes(k))) return null;
  if ((out.wrap !== undefined && typeof out.wrap !== "boolean") || (out.keep_reply !== undefined && typeof out.keep_reply !== "boolean")) return null;
  if (out.text !== undefined && (typeof out.text !== "string" || !isJson(out.text))) return null;
  const d: Decision = { hook, decision: "retry" };
  if (out.text !== undefined) d.text = out.wrap === false ? (out.text as string) : cap(out.text as string);
  if (out.wrap !== undefined) d.wrap = out.wrap as boolean;
  if (out.keep_reply !== undefined) d.keep_reply = out.keep_reply as boolean;
  if (out.replace_context !== undefined) {
    const rc = out.replace_context;
    if (!isObject(rc) || !("text" in rc) || Object.keys(rc).some((k) => k !== "text" && k !== "keep" && k !== "wrap")) return null;
    if (typeof rc.text !== "string" || !isJson(rc.text)) return null;
    if (rc.keep !== undefined && !(Number.isInteger(rc.keep) && (rc.keep as number) >= 0 && (rc.keep as number) <= context)) return null;
    if (rc.wrap !== undefined && typeof rc.wrap !== "boolean") return null;
    d.replace_context = {
      text: rc.wrap === false ? rc.text : cap(rc.text),
      ...(rc.keep !== undefined && { keep: rc.keep as number }), ...(rc.wrap !== undefined && { wrap: rc.wrap as boolean }),
    };
  }
  return d;
}

function matches(match: string | string[] | undefined, key: string | undefined): boolean {
  if (match === undefined || match === "*") return true;
  return key !== undefined && (Array.isArray(match) ? match.includes(key) : match === key);
}

type Call = Extract<ViewEntry, { tool: string }>;

/** A built-in check (§6): null if it passes, else the failure text. */
function check(run: string, w: { [k: string]: Json }, step: number, turn: number, entries: ViewEntry[]): string | null {
  const calls = entries.filter((e): e is Call => "tool" in e);
  const successful = (tool: Json) => (e: Call) => e.tool === tool && e.ok;
  const seen = (e: Call) => e.step < step;
  if (run === "core_called_since") {
    const tools = [w.tool!].flat();
    const named = tools.join(" or ");
    if (w.since === TURN) {
      if (calls.some((e) => tools.some((t) => successful(t)(e)) && seen(e) && e.step > turn)) return null;
      return `${named} not called this turn`;
    }
    const since = w.since === undefined ? -1 : calls.findLastIndex(successful(w.since));
    if (calls.slice(since + 1).some((e) => tools.some((t) => successful(t)(e)) && seen(e))) return null;
    return since >= 0 ? `${named} not called since the last ${w.since}` : `${named} not called yet`;
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

/** A tool call of a model response (§14): `args` with an optional `raw`, or `malformed` text with an optional
 * `parse_error`; an optional id. */
function isResponseCall(c: unknown): boolean {
  if (!isObject(c) || typeof c.tool !== "string" || ("args" in c) === ("malformed" in c)) return false;
  if (c.call_id !== undefined && typeof c.call_id !== "string") return false;
  if ("malformed" in c) {
    return typeof c.malformed === "string" && (c.parse_error === undefined || typeof c.parse_error === "string") && c.raw === undefined;
  }
  return c.parse_error === undefined && (c.raw === undefined || (typeof c.raw === "string" && reads(c.raw, c.args)));
}

/** `raw` is JSON text whose value (read as §1 reads numbers) is `args`. */
function reads(raw: string, args: unknown): boolean {
  try {
    return canonical(JSON.parse(raw)) === canonical(args);
  } catch {
    return false;
  }
}

/** A model response as the transport delivered it; anything else breaks the interface. */
function checkResponse(v: unknown): ModelResponse {
  const ok = isObject(v)
    && (v.text === undefined || typeof v.text === "string")
    && (v.reasoning === undefined || typeof v.reasoning === "string")
    && (v.reasoning_opaque === undefined || (isObject(v.reasoning_opaque) && Object.keys(v.reasoning_opaque).length === 2
      && typeof v.reasoning_opaque.provider === "string" && "data" in v.reasoning_opaque))
    && (v.usage === undefined || isObject(v.usage))
    && (v.finish === undefined || typeof v.finish === "string")
    && (v.failure === undefined || typeof v.failure === "string")
    && (v.tool_calls === undefined || (Array.isArray(v.tool_calls) && v.tool_calls.every(isResponseCall)));
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
