import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentIR, Deployment } from "./types.js";
import { canonicalJson } from "./canonical.js";

export function loadYamlFile(path: string): unknown {
  return parseYaml(readFileSync(path, "utf8"));
}

export function agentYamlToIr(raw: unknown): AgentIR {
  const a = raw as Record<string, unknown>;
  const state = (a.state as Record<string, unknown>) ?? {};
  const tools = (a.tools as AgentIR["tools"]) ?? [];
  const ir: AgentIR = {
    spec: String(a.spec ?? "counterbalance-contract/v0.1"),
    name: String(a.name ?? "unnamed"),
    state: { ...state },
    tools,
  };
  if (a.gates) ir.gates = a.gates as AgentIR["gates"];
  if (a.limits) ir.limits = a.limits as AgentIR["limits"];
  if (a.fallback_state) ir.fallback_state = a.fallback_state as Record<string, unknown>;
  if (a.safe_state) {
    ir.safe_state = a.safe_state as Record<string, unknown>;
    if (!ir.fallback_state) ir.fallback_state = ir.safe_state;
  }
  if (a.recovery) ir.recovery = a.recovery as AgentIR["recovery"];
  if (a.permissions) ir.permissions = a.permissions as AgentIR["permissions"];
  if (a.spawn) ir.spawn = a.spawn as AgentIR["spawn"];
  if (a.counterbalance) ir.counterbalance = a.counterbalance as AgentIR["counterbalance"];
  canonicalJson(ir.state);
  return ir;
}

export function loadAgentDir(dir: string): { agent: AgentIR; agentPath: string } {
  const yml = join(dir, "agent.yml");
  const json = join(dir, "agent.json");
  if (existsSync(yml)) {
    return { agent: agentYamlToIr(loadYamlFile(yml)), agentPath: yml };
  }
  if (existsSync(json)) {
    const ir = JSON.parse(readFileSync(json, "utf8")) as AgentIR;
    if (ir.safe_state && !ir.fallback_state) ir.fallback_state = ir.safe_state;
    canonicalJson(ir.state);
    return { agent: ir, agentPath: json };
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

export function toCanonicalIrJson(agent: AgentIR): string {
  return canonicalJson(agent) + "\n";
}

export function fallbackStateOf(agent: AgentIR): Record<string, unknown> | undefined {
  return agent.fallback_state ?? agent.safe_state;
}
