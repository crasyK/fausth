import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { AgentIR } from "./types.js";
import { agentYamlToIr, loadYamlFile } from "./load.js";
import { canonicalJson } from "./canonical.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type ValidateResult =
  | { ok: true; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

function structuralChecks(agent: AgentIR): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (agent.safe_state && !agent.fallback_state) {
    warnings.push("safe_state is deprecated; use fallback_state");
  }

  const ids = new Set<string>();
  for (const t of agent.tools) {
    if (ids.has(t.id)) errors.push(`Duplicate tool id: ${t.id}`);
    ids.add(t.id);
  }

  for (const t of agent.tools) {
    for (const v of t.verify ?? []) {
      if (v.kind === "effect") {
        const obs = agent.tools.find((x) => x.id === v.observe);
        if (!obs) {
          errors.push(`Tool ${t.id}: effect observe '${v.observe}' not declared`);
        } else if (obs.read_only !== true) {
          errors.push(`Tool ${t.id}: observer '${v.observe}' must have read_only: true`);
        }
      }
    }
  }

  if (agent.recovery) {
    const rt = agent.recovery.execute.tool;
    if (!ids.has(rt)) {
      errors.push(`recovery.execute.tool '${rt}' not declared`);
    }
    if (agent.recovery.verify.kind === "effect") {
      const obsId = agent.recovery.verify.observe;
      const obs = agent.tools.find((x) => x.id === obsId);
      if (!obs) {
        errors.push(`recovery.verify observe '${obsId}' not declared`);
      } else if (obs.read_only !== true) {
        errors.push(`recovery observer '${obsId}' must have read_only: true`);
      }
    }
  }

  if (agent.mutable) {
    const allowed = new Set(["skills", "memory", "instincts"]);
    for (const cell of agent.mutable) {
      if (!allowed.has(cell)) {
        errors.push(`mutable cell '${cell}' is not allowed (skills|memory|instincts only)`);
      }
    }
  }

  return { errors, warnings };
}

export function validateAgent(agent: AgentIR): ValidateResult {
  const schemaPath = join(__dirname, "../../../schema/counterbalance-contract.v0.1.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const warnings: string[] = [];

  try {
    canonicalJson(agent.state);
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e.message : String(e)], warnings };
  }

  const ok = validate(agent);
  const schemaErrors = ok
    ? []
    : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);

  const { errors: structErrors, warnings: structWarnings } = structuralChecks(agent);
  warnings.push(...structWarnings);
  const errors = [...schemaErrors, ...structErrors];
  if (errors.length) return { ok: false, errors, warnings };
  return { ok: true, warnings };
}

export function validateAgentPath(
  path: string,
): { ok: true; agent: AgentIR; warnings: string[] } | { ok: false; errors: string[]; warnings: string[] } {
  let agent: AgentIR;
  if (path.endsWith(".json")) {
    agent = JSON.parse(readFileSync(path, "utf8")) as AgentIR;
  } else if (existsSync(join(path, "agent.yml"))) {
    agent = agentYamlToIr(loadYamlFile(join(path, "agent.yml")));
  } else if (existsSync(join(path, "agent.json"))) {
    agent = JSON.parse(readFileSync(join(path, "agent.json"), "utf8")) as AgentIR;
  } else if (path.endsWith(".yml") || path.endsWith(".yaml")) {
    agent = agentYamlToIr(loadYamlFile(path));
  } else {
    return { ok: false, errors: [`Cannot find agent at ${path}`], warnings: [] };
  }
  const v = validateAgent(agent);
  if (!v.ok) return v;
  return { ok: true, agent, warnings: v.warnings };
}
