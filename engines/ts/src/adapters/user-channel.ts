/**
 * The User cell (D14): tools whose output must come from the user — never from the acting
 * model's own arguments. Deployment binding form:
 *
 *   bindings:
 *     user.ask:
 *       user:
 *         source: recorded | simulator | human
 *         answers: user.answers.jsonl          # recorded (Track A)
 *         model: kit.glm-5.3-flash              # simulator (temperature 0)
 *         system_prompt_file: user-sim.md       # simulator persona / instructions
 *         context_file: hidden-goal.md          # simulator-only context the agent never sees
 *
 * Recorded answers file (JSONL), one entry per answer, consumed at most once, deterministic:
 *   {"tool":"user.ask","call_seq":1,"args":{"question":"..."},
 *    "result":{"output":{"answer":"..."},"state_transition":{"set":{"clarified":1}}}}
 *   - `tool` required; `call_seq` (1-based count of calls to THIS tool in the run) and
 *     `args` (canonical-JSON equality with the call args) are optional match keys;
 *   - `result` is a tool envelope: `output` object required, `state_transition` optional.
 * The runtime still enforces checkpoint authority (allow_set_keys) on any state_transition.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { canonicalJson } from "../canonical.js";
import type { ToolHandler } from "../runtime.js";
import type { Deployment, ToolDef, ToolResultEnvelope } from "../types.js";
import type { ModelPort } from "../model/port.js";
import { createAdapterFromDeployment } from "../model/resolve.js";
import { validateAgainstSchema } from "../schema-validate.js";
import { AdapterError } from "./error.js";
import { resolveHarnessFile } from "./stdio-session.js";

export type UserChannelSource = "recorded" | "simulator" | "human";

export const USER_CHANNEL_SOURCES: readonly UserChannelSource[] = ["recorded", "simulator", "human"];

/** `bindings.<tool>.user` (local type until types.ts carries it). */
export type UserChannelBinding = {
  source: UserChannelSource;
  answers?: string;
  model?: string;
  system_prompt_file?: string;
  context_file?: string;
  /** Optional simulator transport overrides (default: deployment.model settings). */
  profile?: string;
  base_url?: string;
  api_key_env?: string;
  max_tokens?: number;
};

export type UserChannelRequest = {
  tool: string;
  call_seq: number;
  args: Record<string, unknown>;
  description?: string;
  output_schema?: Record<string, unknown>;
  allow_set_keys: string[];
};

export type UserChannelAnswer = {
  output: Record<string, unknown>;
  set?: Record<string, unknown>;
};

export type UserTranscriptEntry = {
  tool: string;
  call_seq: number;
  source: UserChannelSource;
  args: Record<string, unknown>;
  result: ToolResultEnvelope;
  simulator?: { model: string; responses: string[] };
};

export type UserChannelOptions = {
  /** Directory relative file paths in the binding resolve against (contained). */
  baseDir: string;
  deployment: Deployment;
  /** Keys the IR lets this tool set (counterbalance.checkpoints[].allow_set_keys). */
  allowSetKeys?: string[];
  /** In-memory transcript sink (callers persist it with the run). */
  transcript?: UserTranscriptEntry[];
  /** Human source hook (e.g. a UI); default: interactive TTY prompt. */
  humanAnswer?: (req: UserChannelRequest) => Promise<UserChannelAnswer>;
  /** Simulator transport factory (tests); default: createAdapterFromDeployment. */
  simulatorPort?: (deployment: Deployment) => ModelPort;
};

export function isUserChannelBinding(binding: unknown): binding is { user: UserChannelBinding } {
  return Boolean(binding && typeof binding === "object" && "user" in (binding as Record<string, unknown>));
}

function fail(message: string): never {
  throw new AdapterError("user_channel_unavailable", `adapter failure: ${message}`);
}

/** Validate a deployment `user:` binding (closed source set). */
export function parseUserChannelBinding(toolId: string, raw: unknown): UserChannelBinding {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AdapterError("adapter_unresolved", `adapter failure: bindings.${toolId}.user must be an object`);
  }
  const b = raw as Record<string, unknown>;
  if (!USER_CHANNEL_SOURCES.includes(b.source as UserChannelSource)) {
    throw new AdapterError(
      "adapter_unresolved",
      `adapter failure: bindings.${toolId}.user.source must be one of ${USER_CHANNEL_SOURCES.join("|")}`,
    );
  }
  for (const k of ["answers", "model", "system_prompt_file", "context_file", "profile", "base_url", "api_key_env"]) {
    if (b[k] !== undefined && (typeof b[k] !== "string" || !b[k])) {
      throw new AdapterError("adapter_unresolved", `adapter failure: bindings.${toolId}.user.${k} must be a string`);
    }
  }
  if (b.source === "recorded" && !b.answers) {
    throw new AdapterError("adapter_unresolved", `adapter failure: bindings.${toolId}.user recorded source requires answers`);
  }
  if (b.source === "simulator" && !b.model) {
    throw new AdapterError("adapter_unresolved", `adapter failure: bindings.${toolId}.user simulator source requires model`);
  }
  return b as unknown as UserChannelBinding;
}

function asEnvelope(raw: unknown, where: string): ToolResultEnvelope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${where}: result must be an object`);
  const r = raw as Record<string, unknown>;
  if (!r.output || typeof r.output !== "object" || Array.isArray(r.output)) {
    fail(`${where}: result.output must be an object`);
  }
  const st = r.state_transition;
  if (st !== undefined) {
    if (!st || typeof st !== "object" || Array.isArray(st)) fail(`${where}: state_transition must be an object`);
    const set = (st as Record<string, unknown>).set;
    if (set !== undefined && (!set || typeof set !== "object" || Array.isArray(set))) {
      fail(`${where}: state_transition.set must be an object`);
    }
  }
  return {
    output: r.output as Record<string, unknown>,
    ...(st ? { state_transition: st as ToolResultEnvelope["state_transition"] } : {}),
  };
}

type RecordedAnswer = { tool: string; call_seq?: number; args?: Record<string, unknown>; result: ToolResultEnvelope };

function loadRecordedAnswers(baseDir: string, rel: string): RecordedAnswer[] {
  const abs = resolveHarnessFile(baseDir, rel, "user answers");
  const out: RecordedAnswer[] = [];
  const lines = readFileSync(abs, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new AdapterError("adapter_unresolved", `adapter failure: invalid user answers line ${i + 1} in ${rel}`);
    }
    if (!row || typeof row !== "object" || typeof row.tool !== "string") {
      throw new AdapterError("adapter_unresolved", `adapter failure: user answers line ${i + 1} needs a tool`);
    }
    if (row.call_seq !== undefined && !(Number.isInteger(row.call_seq) && (row.call_seq as number) >= 1)) {
      throw new AdapterError("adapter_unresolved", `adapter failure: user answers line ${i + 1} call_seq must be an integer ≥ 1`);
    }
    if (row.args !== undefined && (!row.args || typeof row.args !== "object" || Array.isArray(row.args))) {
      throw new AdapterError("adapter_unresolved", `adapter failure: user answers line ${i + 1} args must be an object`);
    }
    out.push({
      tool: row.tool,
      call_seq: row.call_seq as number | undefined,
      args: row.args as Record<string, unknown> | undefined,
      result: asEnvelope(row.result, `user answers line ${i + 1}`),
    });
  });
  return out;
}

function envelopeFromAnswer(answer: UserChannelAnswer): ToolResultEnvelope {
  return {
    output: answer.output,
    ...(answer.set && Object.keys(answer.set).length ? { state_transition: { set: answer.set } } : {}),
  };
}

/** Parse the simulator's reply: a single JSON object {"output": {...}, "set"?: {...}}. */
export function parseSimulatorReply(
  text: string,
  req: Pick<UserChannelRequest, "output_schema" | "allow_set_keys">,
): { ok: true; answer: UserChannelAnswer } | { ok: false; reason: string } {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, reason: "reply is not a JSON object" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return { ok: false, reason: "reply is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "reply must be an object" };
  const obj = parsed as Record<string, unknown>;
  const output = obj.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) return { ok: false, reason: "missing output object" };
  const check = validateAgainstSchema(req.output_schema, output);
  if (!check.ok) return { ok: false, reason: `output does not match the schema: ${check.errors.join("; ")}` };
  let set: Record<string, unknown> | undefined;
  if (obj.set !== undefined && obj.set !== null) {
    if (typeof obj.set !== "object" || Array.isArray(obj.set)) return { ok: false, reason: "set must be an object" };
    set = obj.set as Record<string, unknown>;
    const bad = Object.keys(set).filter((k) => !req.allow_set_keys.includes(k));
    if (bad.length) return { ok: false, reason: `set may only contain [${req.allow_set_keys.join(", ")}]` };
  }
  return { ok: true, answer: { output: output as Record<string, unknown>, ...(set ? { set } : {}) } };
}

const DEFAULT_SIMULATOR_PROMPT =
  "You are the human user of a software agent. Answer the agent's questions truthfully and briefly, " +
  "from your own point of view, using only what you know. Do not perform the agent's task for it.";

function simulatorSystemPrompt(
  persona: string,
  hidden: string | undefined,
  tool: ToolDef,
  allowSetKeys: string[],
): string {
  const parts = [persona.trim()];
  if (hidden && hidden.trim()) {
    parts.push(
      "## What you know (private to you; the agent cannot see this)",
      hidden.trim(),
    );
  }
  parts.push(
    "## Reply protocol",
    `The agent reaches you through the tool "${tool.id}"${tool.description ? ` (${tool.description})` : ""}.`,
    'Reply with ONLY one JSON object: {"output": <object>' + (allowSetKeys.length ? ', "set": <object>' : "") + "}.",
    `"output" must satisfy this JSON Schema: ${canonicalJson(tool.output ?? { type: "object" })}`,
    allowSetKeys.length
      ? `"set" is optional and may only contain these keys: ${allowSetKeys.join(", ")}.`
      : 'Do not include "set".',
  );
  return parts.join("\n\n");
}

/**
 * Coerce a typed human answer into a tool output: JSON {"output":..,"set":..} or a bare
 * output object; otherwise a single required string property takes the text, a single
 * required integer/boolean property takes yes/no.
 */
export function coerceHumanAnswer(text: string, schema: Record<string, unknown> | undefined): UserChannelAnswer | null {
  const t = text.trim();
  if (t.startsWith("{")) {
    try {
      const parsed = JSON.parse(t) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if (parsed.output && typeof parsed.output === "object" && !Array.isArray(parsed.output)) {
          const set = parsed.set && typeof parsed.set === "object" && !Array.isArray(parsed.set)
            ? (parsed.set as Record<string, unknown>)
            : undefined;
          return { output: parsed.output as Record<string, unknown>, ...(set ? { set } : {}) };
        }
        return { output: parsed };
      }
    } catch {
      return null;
    }
  }
  const props = (schema?.properties ?? {}) as Record<string, { type?: string }>;
  const required = Array.isArray(schema?.required) ? (schema!.required as string[]) : Object.keys(props);
  if (required.length !== 1) return null;
  const key = required[0]!;
  const type = props[key]?.type;
  if (type === "string" || type === undefined) return { output: { [key]: t } };
  if (type === "integer" || type === "number" || type === "boolean") {
    const yes = /^(y|yes|1|true)$/i.test(t);
    const no = /^(n|no|0|false)$/i.test(t);
    if (!yes && !no) return null;
    return { output: { [key]: type === "boolean" ? yes : yes ? 1 : 0 } };
  }
  return null;
}

async function ttyHumanAnswer(req: UserChannelRequest): Promise<UserChannelAnswer> {
  if (!process.stdin.isTTY) {
    fail(`user channel '${req.tool}' (human) needs an interactive terminal or a humanAnswer callback`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const answer = await new Promise<string>((resolve) =>
        rl.question(
          `\n--- the agent asks you (${req.tool} #${req.call_seq}) ---\n${canonicalJson(req.args)}\n` +
            `Your answer (text, yes/no, or JSON {"output":...,"set":...}): `,
          resolve,
        ),
      );
      const coerced = coerceHumanAnswer(answer, req.output_schema);
      if (coerced) return coerced;
      process.stderr.write("Could not map that answer to the tool output schema; try again.\n");
    }
  } finally {
    rl.close();
  }
  return fail(`user channel '${req.tool}': no usable human answer`);
}

function persistTranscript(entry: UserTranscriptEntry, sink?: UserTranscriptEntry[]): void {
  sink?.push(entry);
  const path = process.env.FAUSTH_USER_TRANSCRIPT;
  if (path) appendFileSync(path, canonicalJson(entry) + "\n", "utf8");
}

/** Build the handler for one user-channel tool. */
export function createUserChannelHandler(
  tool: ToolDef,
  binding: UserChannelBinding,
  opts: UserChannelOptions,
): ToolHandler {
  const allowSetKeys = [...(opts.allowSetKeys ?? [])];
  let callSeq = 0;

  if (binding.source === "recorded") {
    const answers = loadRecordedAnswers(opts.baseDir, binding.answers!);
    const used = new Set<number>();
    return (args) => {
      callSeq += 1;
      const argsCanon = canonicalJson(args ?? {});
      const idx = answers.findIndex(
        (a, i) =>
          !used.has(i) &&
          a.tool === tool.id &&
          (a.call_seq === undefined || a.call_seq === callSeq) &&
          (a.args === undefined || canonicalJson(a.args) === argsCanon),
      );
      if (idx < 0) fail(`no recorded user answer for '${tool.id}' call #${callSeq}`);
      used.add(idx);
      const result = structuredClone(answers[idx]!.result);
      persistTranscript({ tool: tool.id, call_seq: callSeq, source: "recorded", args, result }, opts.transcript);
      return result;
    };
  }

  if (binding.source === "human") {
    const ask = opts.humanAnswer ?? ttyHumanAnswer;
    return async (args) => {
      callSeq += 1;
      const req: UserChannelRequest = {
        tool: tool.id,
        call_seq: callSeq,
        args,
        description: tool.description,
        output_schema: tool.output,
        allow_set_keys: allowSetKeys,
      };
      const answer = await ask(req);
      if (!answer || !answer.output || typeof answer.output !== "object") {
        fail(`user channel '${tool.id}': human answer must provide an output object`);
      }
      const result = envelopeFromAnswer(answer);
      persistTranscript({ tool: tool.id, call_seq: callSeq, source: "human", args, result }, opts.transcript);
      return result;
    };
  }

  // simulator
  const persona = binding.system_prompt_file
    ? readFileSync(resolveHarnessFile(opts.baseDir, binding.system_prompt_file, "user simulator prompt"), "utf8")
    : DEFAULT_SIMULATOR_PROMPT;
  const hidden = binding.context_file
    ? readFileSync(resolveHarnessFile(opts.baseDir, binding.context_file, "user simulator context"), "utf8")
    : undefined;
  const simDeployment: Deployment = {
    ...opts.deployment,
    model: {
      ...opts.deployment.model,
      ...(binding.profile ? { profile: binding.profile as Deployment["model"]["profile"] } : {}),
      ...(binding.base_url ? { base_url: binding.base_url } : {}),
      ...(binding.api_key_env ? { api_key_env: binding.api_key_env } : {}),
      models: [binding.model!],
      model: undefined,
      temperature: 0,
      max_tokens: binding.max_tokens ?? 512,
    },
    bindings: {},
  };
  if (simDeployment.model.transport === "recorded" || simDeployment.model.transport === undefined) {
    simDeployment.model.transport = "openai-compatible";
  }
  let port: ModelPort;
  try {
    port = opts.simulatorPort ? opts.simulatorPort(simDeployment) : createAdapterFromDeployment(simDeployment).adapter;
  } catch (e) {
    fail(`user simulator for '${tool.id}' unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
  const messages: { role: string; content: string }[] = [
    { role: "system", content: simulatorSystemPrompt(persona, hidden, tool, allowSetKeys) },
  ];
  return async (args) => {
    callSeq += 1;
    const req = { output_schema: tool.output, allow_set_keys: allowSetKeys };
    messages.push({ role: "user", content: `${tool.id} call #${callSeq}\narguments: ${canonicalJson(args ?? {})}` });
    const responses: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      let proposal;
      try {
        proposal = await port.propose({ messages, tools: [] });
      } catch (e) {
        // Transport / gateway failure of the simulator is infrastructure, not agent behavior.
        messages.pop();
        return fail(`user simulator for '${tool.id}' failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const text = proposal.type === "stop" ? (proposal.message ?? "") : "";
      responses.push(text);
      messages.push({ role: "assistant", content: text });
      const parsed = parseSimulatorReply(text, req);
      if (parsed.ok) {
        const result = envelopeFromAnswer(parsed.answer);
        persistTranscript(
          { tool: tool.id, call_seq: callSeq, source: "simulator", args, result, simulator: { model: binding.model!, responses } },
          opts.transcript,
        );
        return result;
      }
      messages.push({
        role: "user",
        content: `Your reply could not be used (${parsed.reason}). Reply again with only the JSON object.`,
      });
    }
    return fail(`user simulator for '${tool.id}' gave no usable answer for call #${callSeq}`);
  };
}
