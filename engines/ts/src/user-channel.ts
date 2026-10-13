/**
 * User channel (spec-v0.3 §9, §15.2; D14).
 *
 * A `channel: user` tool is answered by the host's user channel — recorded answers in Track A,
 * a human or a declared simulator live — never by a world stub and never from the acting
 * model's own arguments (the arguments are the question).
 *
 * This module provides the contract-level pieces every host needs:
 * - recorded answers (`{tool, args?, result}` JSONL) → handlers that consume answers per tool;
 * - helpers to split a harness into its world-channel and user-channel tools;
 * - resolution of `bindings.<tool>.user` with `source: recorded` (simulator / human are
 *   live-host concerns implemented by deployment adapters).
 */
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { deepEq } from "./canonical.js";
import { readJsonl } from "./load.js";
import { TranscriptError, type ToolHandler } from "./runtime.js";
import type { AgentIR, Deployment, RecordedUserAnswer, ToolDef } from "./types.js";

export function isUserChannelTool(tool: ToolDef): boolean {
  return (tool.channel ?? "world") === "user";
}

/** Ids of the harness's user-channel tools. */
export function userChannelToolIds(agent: AgentIR): string[] {
  return (agent.tools ?? []).filter(isUserChannelTool).map((t) => t.id);
}

/**
 * The harness restricted to world-channel tools — for world-tool registries that require a
 * native binding for every tool they see. User-channel tools are bound separately.
 */
export function worldChannelAgent(agent: AgentIR): AgentIR {
  return { ...agent, tools: (agent.tools ?? []).filter((t) => !isUserChannelTool(t)) };
}

/** Drop handlers for user-channel tools (a world stub must never answer for the user). */
export function withoutUserChannelHandlers(
  agent: AgentIR,
  handlers: Record<string, ToolHandler>,
): Record<string, ToolHandler> {
  const user = new Set(userChannelToolIds(agent));
  const out: Record<string, ToolHandler> = {};
  for (const [id, h] of Object.entries(handlers)) if (!user.has(id)) out[id] = h;
  return out;
}

export function loadRecordedUserAnswers(path: string): RecordedUserAnswer[] {
  return readJsonl(path).map((line, i) => {
    const o = line as Record<string, unknown>;
    if (!o || typeof o !== "object" || typeof o.tool !== "string" || !o.result || typeof o.result !== "object") {
      throw new Error(`${path}:${i + 1}: recorded user answer needs {tool, result, args?}`);
    }
    return o as unknown as RecordedUserAnswer;
  });
}

/**
 * Handlers that answer user-channel tools from recorded answers, per tool in file order
 * (spec-v0.3 §15.2). An answer with `args` must match the question canonically.
 */
export function recordedUserChannel(
  answers: RecordedUserAnswer[],
  toolIds: Iterable<string>,
): Record<string, ToolHandler> {
  const queues = new Map<string, RecordedUserAnswer[]>();
  for (const a of answers) {
    const q = queues.get(a.tool) ?? [];
    q.push(a);
    queues.set(a.tool, q);
  }
  const handlers: Record<string, ToolHandler> = {};
  for (const id of toolIds) {
    let calls = 0;
    handlers[id] = (args) => {
      calls += 1;
      const q = queues.get(id) ?? [];
      const answer = q[calls - 1];
      if (!answer) throw new TranscriptError("exhausted", calls);
      if (answer.args !== undefined && !deepEq(answer.args, args)) {
        throw new TranscriptError("mismatch", calls);
      }
      return structuredClone(answer.result);
    };
  }
  return handlers;
}

export type UserBindingSpec = {
  source: "recorded" | "simulator" | "human";
  answers?: string;
  model?: string;
  system_prompt_file?: string;
  context_file?: string;
};

export type UserChannelResolution = {
  handlers: Record<string, ToolHandler>;
  /** User-channel tools left unbound (calls will be denied: capability_missing / channel_unbound). */
  unbound: { tool: string; why: "no_user_binding" | "source_not_supported_by_host" }[];
};

export function userBindingOf(deployment: Deployment, toolId: string): UserBindingSpec | undefined {
  const b = (deployment.bindings ?? {})[toolId] as Record<string, unknown> | undefined;
  const user = b?.user;
  if (!user || typeof user !== "object") return undefined;
  return user as UserBindingSpec;
}

/**
 * Resolve `bindings.<tool>.user` for the harness's user-channel tools. This contract-level
 * resolver implements `source: recorded`; `simulator` / `human` are supplied by live
 * deployment adapters (they are reported as unbound here, never faked).
 */
export function resolveRecordedUserBindings(
  agent: AgentIR,
  deployment: Deployment,
  opts: { harnessDir: string },
): UserChannelResolution {
  const handlers: Record<string, ToolHandler> = {};
  const unbound: UserChannelResolution["unbound"] = [];
  const byFile = new Map<string, RecordedUserAnswer[]>();
  for (const id of userChannelToolIds(agent)) {
    const spec = userBindingOf(deployment, id);
    if (!spec) {
      unbound.push({ tool: id, why: "no_user_binding" });
      continue;
    }
    if (spec.source !== "recorded" || typeof spec.answers !== "string") {
      unbound.push({ tool: id, why: "source_not_supported_by_host" });
      continue;
    }
    const path = isAbsolute(spec.answers) ? spec.answers : join(opts.harnessDir, spec.answers);
    if (!existsSync(path)) {
      throw new Error(`user channel: recorded answers not found for '${id}': ${path}`);
    }
    let answers = byFile.get(path);
    if (!answers) {
      answers = loadRecordedUserAnswers(path);
      byFile.set(path, answers);
    }
    Object.assign(handlers, recordedUserChannel(answers, [id]));
  }
  return { handlers, unbound };
}
