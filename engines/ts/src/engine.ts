// The run loop (spec §8).
import type { Harness, Limits } from "./harness.js";
import { Log, TOP, callId, type Scope } from "./log.js";
import { render, type Request, type ToolCall } from "./render.js";
import { compileSchema, type Check } from "./schema.js";
import { canonical, hash, type Json } from "./values.js";

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
  private inputs = new Map<string, Check>();
  private outputs = new Map<string, Check>();

  constructor(readonly harness: Harness, readonly host: Host, readonly log: Log, readonly scope: Scope) {
    for (const [id, t] of Object.entries(harness.tools ?? {})) {
      if (t.input) this.inputs.set(id, compileSchema(t.input));
      if (t.output) this.outputs.set(id, compileSchema(t.output));
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
      this.append("system", { text: this.harness.prompt });
      for (;;) {
        const text = await this.host.user();
        if (text === null) throw new Ended("stop");
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
    for (;;) {
      if (this.step === this.limit("max_steps")) throw new Ended("limit");
      const response = checkResponse(await this.host.model(render(this.harness, this.log.entries, this.scope)));
      this.step += 1;
      const seq = this.log.entries.length + 1;
      const calls: ToolCall[] = (response.tool_calls ?? []).map((c, i) => ({ call_id: callId(seq, i), tool: c.tool, args: c.args }));
      this.append("assistant", {
        step: this.step,
        text: response.text ?? "",
        tool_calls: calls,
        ...(response.reasoning !== undefined && { reasoning: response.reasoning }),
        ...(response.reasoning_opaque !== undefined && { reasoning_opaque: response.reasoning_opaque }),
      });
      for (const call of calls) await this.toolCall(call);
      if (calls.length === 0) return;
    }
  }

  private async toolCall(call: ToolCall): Promise<void> {
    if (this.toolCalls === this.limit("max_tool_calls")) throw new Ended("limit");
    this.toolCalls += 1;
    if (!Object.hasOwn(this.harness.tools ?? {}, call.tool)) {
      this.result(call, { ok: false, error: "invalid arguments: unknown tool" });
      return;
    }
    if (!this.inputs.get(call.tool)!(call.args)) {
      this.result(call, { ok: false, error: "invalid arguments: does not match the input schema" });
      return;
    }
    this.result(call, checkAnswer(await this.host.call(call.tool, call.args), this.outputs.get(call.tool)));
  }

  private result(call: ToolCall, answer: Answer): void {
    this.append("tool_result", { call_id: call.call_id, tool: call.tool, ...answer });
  }
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
