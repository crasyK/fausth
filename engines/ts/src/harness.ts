// The harness file (spec §2, §2.1, §3, §5.1, §6, §8.2): reading it, filling its host values, checking it.
import { Ajv2020 } from "ajv/dist/2020.js";
import { parseDocument } from "yaml";
import schema07 from "../../../schema/harness.v0.7.json" with { type: "json" };
import { compileSchema } from "./schema.js";
import { canonical, hash, type ArgumentForm, type Json } from "./values.js";

export type Event =
  | "session_start" | "user_prompt" | "pre_request" | "post_response" | "pre_check" | "pre_tool" | "post_tool"
  | "stop" | "interrupt";
export type Schema = { [key: string]: Json };

export interface Tool { description?: string; input?: Schema; output?: Schema }
export interface Handler { description?: string; input?: Schema }
export interface Hook {
  id: string;
  on: Event;
  match?: string | string[];
  run: string;
  with?: { [key: string]: Json };
  on_failure?: "end" | "skip";
}
export interface Limits {
  max_steps?: number;
  max_tool_calls?: number;
  max_depth?: number;
  max_continues?: number;
  max_hook_text?: number;
  timeout_ms?: number;
}
export type TextName = "unknown_tool" | "invalid_arguments" | "malformed_arguments" | "tool_error";
export interface Harness {
  spec: string;
  name: string;
  prompt: string;
  tools?: { [id: string]: Tool };
  handlers?: { [id: string]: Handler };
  hooks?: Hook[];
  limits?: Limits;
  texts?: { [name in TextName]?: string };
  /** How a call's arguments go back to the model (§9.4); `model_order` when absent. */
  argument_text?: ArgumentForm;
  /** The host values the file uses beyond the standard ones (§2.1). */
  host_values?: string[];
}

/** The only spec value this engine runs: a 0.7 engine runs only `harness/0.7` files (spec, Versions). */
export const SPEC = "harness/0.7";

/** The engine's texts (§8.2): each one's placeholders and its default (`tool_error` has none: §9.3). */
export const TEXTS: Record<TextName, { placeholders: string[]; default?: string }> = {
  unknown_tool: { placeholders: ["tool", "args", "args_indented"], default: "invalid arguments: unknown tool" },
  invalid_arguments: { placeholders: ["tool", "args", "args_indented", "reasons"], default: "invalid arguments: {reasons}" },
  malformed_arguments: {
    placeholders: ["tool", "text", "parse_error"], default: "invalid arguments: the arguments must be a JSON object",
  },
  tool_error: { placeholders: ["error"] },
};
const PLACEHOLDER = /\{([a-z_]+)\}/g;

/** A text of `texts` (or its default) with its placeholders filled in (§8.2); values are not escaped. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (whole, name: string) => (Object.hasOwn(values, name) ? values[name]! : whole));
}

/** The ids of `tools` in the order the model is offered them (§9): member order (§1), which `Object.keys` gives. */
export function toolIds(h: Harness): string[] {
  return Object.keys(h.tools ?? {});
}

/** `harness_hash` (§2): the hash of the resolved harness with its tool order. */
export function harnessHash(h: Harness): Promise<string> {
  return hash([h as unknown as Json, toolIds(h)]);
}

/** The standard host values (§2.1); a file declares any other name it uses in `host_values`. */
export const STANDARD_VALUES = ["CWD", "HOME", "DATE", "YEAR", "TIMEZONE", "OS", "MODEL", "PROVIDER"] as const;
const BLOCK = /\n\n\$\{if ([A-Z][A-Z0-9_]*)\}\n([\s\S]*?)\n\$\{end\}(?=\n\n|$)/g;
const SLOT = /\n\n\$\{([A-Z][A-Z0-9_]*)\}(?=\n\n|$)/g;
const TOKEN = /\$\$\{|\$\{([A-Z][A-Z0-9_]*)\}|\$\{(?:if |end\})/g;

/** The harness with its host values filled in (§2.1): `prompt` and every tool's `description`. Throws for a load
 * error: a name neither standard nor declared, a name without a value, a value that isn't a string, or `${if …}` /
 * `${end}` outside a block. The harness itself is checked by `harnessErrors`, not here. */
export function fillHostValues(harness: Harness, values: Record<string, unknown>): Harness {
  const declared = Array.isArray(harness.host_values) ? harness.host_values.filter((n) => typeof n === "string") : [];
  const known = new Set<string>([...STANDARD_VALUES, ...declared]);
  const value = (name: string): string => {
    if (!known.has(name)) throw new Error(`\${${name}} is neither a standard host value nor declared in host_values`);
    if (!Object.hasOwn(values, name)) throw new Error(`no value for \${${name}}`);
    const v = values[name];
    if (typeof v !== "string") throw new Error(`the value of \${${name}} is not a string`);
    return v;
  };
  const fillText = (text: string): string => {
    const blocks = text.replace(BLOCK, (_, name: string, body: string) => (value(name) !== "" ? `\n\n${body}` : ""));
    const slots = blocks.replace(SLOT, (whole, name: string) => (value(name) !== "" ? whole : ""));
    return slots.replace(TOKEN, (whole, name: string | undefined) => {
      if (whole === "$${") return "${";
      if (name === undefined) throw new Error("${if …} or ${end} outside a block");
      return value(name);
    });
  };
  const out: Harness = { ...harness };
  if (typeof out.prompt === "string") out.prompt = fillText(out.prompt);
  if (out.tools && typeof out.tools === "object") {
    out.tools = Object.fromEntries(Object.entries(out.tools).map(([id, t]) => [
      id, t && typeof t === "object" && typeof t.description === "string" ? { ...t, description: fillText(t.description) } : t,
    ]));
  }
  return out;
}

export const BUILT_INS = new Set(["core_called_since", "core_last_result", "core_count", "core_deny", "core_context"]);
/** `core_called_since`'s `since` for "since the current turn began" (§6); `@` can't occur in a tool id (§3.1). */
export const TURN = "@turn";

/** The built-in tool `core_spawn` as the model sees it (§10). */
export const SPAWN_DESCRIPTION =
  "Run a child agent on a subtask. harness: the child's complete harness; it may use only tools and handlers you have. task: its first user message. Returns the child's final text.";
export const SPAWN_INPUT: Schema = {
  type: "object",
  required: ["harness", "task"],
  additionalProperties: false,
  properties: { harness: { type: "object" }, task: { type: "string" } },
};

/** A declared tool as the model sees it: `core_spawn` gets its fixed schema and default description. */
export function shownTool(id: string, t: Tool): { description: string; input: Schema } {
  if (id === "core_spawn") return { description: t.description ?? SPAWN_DESCRIPTION, input: SPAWN_INPUT };
  return { description: t.description ?? "", input: t.input ?? {} };
}

/** Harness text as a JSON value: YAML 1.2 core schema, JSON read as YAML (§2). Throws otherwise. */
export function readHarness(text: string): Json {
  const doc = parseDocument(text, { version: "1.2", schema: "core", uniqueKeys: true, merge: false, prettyErrors: false });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) throw new Error(problem.message);
  if (doc.directives?.yaml.version !== "1.2") throw new Error("only YAML 1.2 is supported");
  return toJson(doc.toJS({ mapAsMap: true, maxAliasCount: -1 }));
}

function toJson(v: unknown): Json {
  if (v instanceof Map) {
    const members: [string, Json][] = [];
    for (const [k, x] of v) {
      if (typeof k !== "string") throw new Error(`mapping key ${String(k)} is not a string`);
      members.push([k, toJson(x)]);
    }
    return Object.fromEntries(members);
  }
  if (Array.isArray(v)) return v.map(toJson);
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  throw new Error(`not a JSON value: ${String(v)}`);
}

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
const checkStructure = ajv.compile(schema07);

/** What is wrong with a harness; empty if it is valid. */
export function harnessErrors(value: unknown): string[] {
  try {
    canonical(value);
  } catch (e) {
    return [`no canonical form (§1): ${e instanceof Error ? e.message : String(e)}`];
  }
  if (!checkStructure(value)) {
    return (checkStructure.errors ?? []).map((e) => `${e.instancePath || "/"}: ${e.message ?? "invalid"}`);
  }
  const h = value as unknown as Harness;
  const tools = h.tools ?? {};
  const handlers = h.handlers ?? {};
  const errors: string[] = [];

  for (const id of Object.keys(handlers)) {
    if (Object.hasOwn(tools, id)) errors.push(`${id}: declared as a tool and as a handler`);
  }
  const schemas: [string, Schema | undefined][] = [];
  for (const [id, t] of Object.entries(tools)) schemas.push([`tools.${id}.input`, t.input], [`tools.${id}.output`, t.output]);
  for (const [id, x] of Object.entries(handlers)) schemas.push([`handlers.${id}.input`, x.input]);
  for (const [where, schema] of schemas) {
    if (schema === undefined) continue;
    try {
      compileSchema(schema);
    } catch (e) {
      errors.push(`${where}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const hookIds = new Set<string>();
  for (const hook of h.hooks ?? []) {
    if (hookIds.has(hook.id)) errors.push(`hook ${hook.id}: id is not unique`);
    hookIds.add(hook.id);
    if (!BUILT_INS.has(hook.run) && !Object.hasOwn(handlers, hook.run)) {
      errors.push(`hook ${hook.id}: ${hook.run} is not a declared handler or a built-in`);
    }
    const toolRefs: unknown[] = [];
    if ((hook.on === "pre_check" || hook.on === "pre_tool" || hook.on === "post_tool") && hook.match !== undefined && hook.match !== "*") {
      toolRefs.push(...[hook.match].flat());
    }
    if (BUILT_INS.has(hook.run)) toolRefs.push(...[hook.with?.tool].flat(), ...(hook.with?.since === TURN ? [] : [hook.with?.since]));
    for (const id of toolRefs) {
      if (typeof id === "string" && !Object.hasOwn(tools, id)) errors.push(`hook ${hook.id}: ${id} is not a declared tool`);
    }
  }
  for (const [name, template] of Object.entries(h.texts ?? {})) {
    const allowed = TEXTS[name as TextName].placeholders;
    for (const [, placeholder] of template.matchAll(PLACEHOLDER)) {
      if (!allowed.includes(placeholder!)) errors.push(`texts.${name}: {${placeholder}} is not one of its placeholders`);
    }
  }
  return errors;
}
