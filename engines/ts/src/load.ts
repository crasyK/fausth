import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentIR, Deployment, ModelProposal } from "./types.js";
import { canonicalJson } from "./canonical.js";

/** YAML 1.2 core schema (D4): yes/no/on/off are strings; duplicate keys are an error. */
export const YAML_OPTIONS = {
  version: "1.2",
  schema: "core",
  uniqueKeys: true,
  merge: false,
  intAsBigInt: false,
} as const;

export function parseYamlText(text: string): unknown {
  return parseYaml(text, YAML_OPTIONS);
}

export function loadYamlFile(path: string): unknown {
  return parseYamlText(readFileSync(path, "utf8"));
}

/**
 * Normalization shared by every loader and the engine (spec-v0.3 §2.2):
 * `safe_state` without `fallback_state` ⇒ `fallback_state := safe_state`.
 * Returns a shallow copy; never mutates the input.
 */
export function normalizeAgentIr(agent: AgentIR): AgentIR {
  const out: AgentIR = { ...agent };
  if (out.safe_state && !out.fallback_state) out.fallback_state = out.safe_state;
  return out;
}

/**
 * YAML/JSON document → IR. Every top-level key is carried over so validation can reject
 * unknown ones (a typo like `counterbalnce:` must not silently disappear).
 */
export function agentYamlToIr(raw: unknown): AgentIR {
  const a = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >;
  // No defaults: a missing spec/name/state/tools is a validation error, not a silent guess.
  return normalizeAgentIr({ ...a } as unknown as AgentIR);
}

export function loadAgentFile(path: string): AgentIR {
  if (path.endsWith(".json")) {
    return normalizeAgentIr(JSON.parse(readFileSync(path, "utf8")) as AgentIR);
  }
  return agentYamlToIr(loadYamlFile(path));
}

export function loadAgentDir(dir: string): { agent: AgentIR; agentPath: string } {
  const yml = join(dir, "agent.yml");
  const json = join(dir, "agent.json");
  if (existsSync(yml)) {
    return { agent: loadAgentFile(yml), agentPath: yml };
  }
  if (existsSync(json)) {
    return { agent: loadAgentFile(json), agentPath: json };
  }
  throw new Error(`No agent.yml or agent.json in ${dir}`);
}

export function loadDeployment(path: string): Deployment {
  return loadYamlFile(path) as Deployment;
}

export function listFixtureDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(root, d.name))
    .sort();
}

export function readJsonl(path: string): unknown[] {
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.map((l) => JSON.parse(l));
}

/**
 * Recorded model line → proposal (spec-v0.3 §15.4):
 * `{type: "tool", name, args}` · `{type: "stop", message?}` · `{type: "invalid", reason, message?}`.
 */
export function parseRecordedProposal(line: unknown): ModelProposal {
  const o = (line ?? {}) as Record<string, unknown>;
  if (o.type === "stop") {
    return typeof o.message === "string" ? { type: "stop", message: o.message } : { type: "stop" };
  }
  if (o.type === "invalid") {
    return {
      type: "invalid",
      reason: typeof o.reason === "string" ? o.reason : "invalid",
      ...(typeof o.message === "string" ? { message: o.message } : {}),
    };
  }
  if (o.type === "tool" || typeof o.name === "string") {
    return {
      type: "tool",
      name: String(o.name ?? o.tool),
      args: (o.args as Record<string, unknown>) ?? {},
    };
  }
  throw new Error(`Invalid model.jsonl entry: ${JSON.stringify(line)}`);
}

export function toCanonicalIrJson(agent: AgentIR): string {
  return canonicalJson(agent) + "\n";
}

export function fallbackStateOf(agent: AgentIR): Record<string, unknown> | undefined {
  return agent.fallback_state ?? agent.safe_state;
}
