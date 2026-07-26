import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { AgentIR } from "./types.js";
import { agentYamlToIr, loadYamlFile } from "./load.js";
import { canonicalJson } from "./canonical.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function validateAgent(agent: AgentIR): { ok: true } | { ok: false; errors: string[] } {
  const schemaPath = join(__dirname, "../../../schema/counterbalance-contract.v0.1.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  // Integers-only deep check on state
  try {
    canonicalJson(agent.state);
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
  }
  const ok = validate(agent);
  if (!ok) {
    return {
      ok: false,
      errors: (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`),
    };
  }
  // judge forbidden check is fixture-time
  for (const t of agent.tools) {
    for (const v of t.verify ?? []) {
      if (v.kind === "judge") {
        // allowed in agent.yml for live; warn only in validate
      }
    }
  }
  return { ok: true };
}

export function validateAgentPath(path: string): { ok: true; agent: AgentIR } | { ok: false; errors: string[] } {
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
    return { ok: false, errors: [`Cannot find agent at ${path}`] };
  }
  const v = validateAgent(agent);
  if (!v.ok) return v;
  return { ok: true, agent };
}
