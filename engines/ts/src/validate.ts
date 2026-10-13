import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv/dist/2020.js";
import type { AgentIR, Predicate, ToolDef, Verify } from "./types.js";
import { SPAWN_TOOL } from "./types.js";
import { loadAgentFile } from "./load.js";
import { toCanonical } from "./canonical.js";
import { predicatePaths } from "./predicates.js";
import { parseScope } from "./scopes.js";
import { schemaCompiles, validateAgainstSchema } from "./schema-validate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The executable IR schema of record (spec-v0.3 §2.1). */
export const CONTRACT_SCHEMA_PATH = join(
  __dirname,
  "../../../schema/counterbalance-contract.v0.1.json",
);

export type ValidateResult =
  | { ok: true; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

let contractValidator: ValidateFunction | undefined;

function contractSchemaValidator(): ValidateFunction {
  if (!contractValidator) {
    const schema = JSON.parse(readFileSync(CONTRACT_SCHEMA_PATH, "utf8"));
    const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
    contractValidator = ajv.compile(schema);
  }
  return contractValidator;
}

/** Allowed snapshot roots per predicate context (spec-v0.3 §3.2). */
const ROOTS = {
  gate: ["action", "state"],
  sequence: ["action", "state"],
  completion: ["state"],
  effect: ["action", "state", "result", "observation"],
  evidence: ["action", "state", "result"],
  absence: ["action", "state", "result"],
  output: ["action", "state", "result", "message"],
  judge: ["action", "state", "result", "judgment"],
  agent_output: ["state", "message"],
  state_effect: ["action", "state", "result"],
} as const;

function checkRoots(
  pred: Predicate | undefined,
  allowed: readonly string[],
  where: string,
  errors: string[],
): void {
  if (!pred) return;
  for (const p of predicatePaths(pred)) {
    const root = p.split(".")[0] ?? "";
    if (!allowed.includes(root)) {
      errors.push(`${where}: path '${p}' must start with one of ${allowed.join("|")}`);
    }
  }
}

function verifyRoots(v: Verify): readonly string[] {
  return ROOTS[v.kind as keyof typeof ROOTS] ?? [];
}

/** Structural rules the JSON Schema cannot express (spec-v0.3 §2.6). */
function structuralChecks(agent: AgentIR): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const tools: ToolDef[] = Array.isArray(agent.tools) ? agent.tools : [];
  const state = agent.state && typeof agent.state === "object" ? agent.state : {};
  const stateKeys = new Set(Object.keys(state));

  if (agent.safe_state) {
    warnings.push("safe_state is deprecated; use fallback_state");
  }

  const ids = new Set<string>();
  for (const t of tools) {
    if (ids.has(t.id)) errors.push(`Duplicate tool id: ${t.id}`);
    ids.add(t.id);
  }
  const byId = new Map(tools.map((t) => [t.id, t] as const));
  const declared = (id: string) => ids.has(id);

  // Rule 3: permissions.tools ⊆ declared
  const permitted = agent.permissions?.tools;
  for (const id of permitted ?? []) {
    if (!declared(id)) errors.push(`permissions.tools: '${id}' is not a declared tool`);
  }
  const permittedSet = new Set(permitted ?? [...ids]);

  // Rule 4: scopes normalize
  for (const kind of ["write_scopes", "read_scopes"] as const) {
    for (const s of agent.permissions?.filesystem?.[kind] ?? []) {
      const r = parseScope(s);
      if (!r.ok) errors.push(`permissions.filesystem.${kind}: '${s}' is invalid (${r.problem})`);
    }
  }

  // Rule 5: observers
  const checkObserver = (obsId: string, where: string) => {
    const obs = byId.get(obsId);
    if (!obs) {
      errors.push(`${where}: effect observe '${obsId}' not declared`);
      return;
    }
    if (obs.read_only !== true) errors.push(`${where}: observer '${obsId}' must have read_only: true`);
    if ((obs.channel ?? "world") !== "world") {
      errors.push(`${where}: observer '${obsId}' must be a world-channel tool`);
    }
    const accepts = validateAgainstSchema(obs.input, {});
    if (!accepts.ok) errors.push(`${where}: observer '${obsId}' input schema must accept {}`);
  };

  for (const t of tools) {
    for (const v of t.verify ?? []) {
      if (v.kind === "effect") checkObserver(v.observe, `Tool ${t.id}`);
      checkRoots(v.require, verifyRoots(v), `Tool ${t.id} verify ${v.kind}`, errors);
    }
    // Rule 16: declared effects write declared keys within the tool's authority
    (t.effects ?? []).forEach((eff, i) => {
      const where = `Tool ${t.id} effects[${i}]`;
      checkRoots(eff.when, ROOTS.state_effect, `${where}.when`, errors);
      const own = (agent.counterbalance?.checkpoints ?? []).find((c) => c.tool === t.id);
      for (const key of Object.keys(eff.set ?? {})) {
        if (!stateKeys.has(key)) {
          errors.push(`${where}.set: '${key}' is not a declared state key`);
          continue;
        }
        const owned = (agent.counterbalance?.checkpoints ?? []).some((c) => c.allow_set_keys.includes(key));
        if (own ? !own.allow_set_keys.includes(key) : owned) {
          errors.push(`${where}.set: '${key}' is a checkpoint key this tool does not own`);
        }
      }
    });
    // Rule 15: schemas compile
    for (const which of ["input", "output"] as const) {
      const err = schemaCompiles(t[which]);
      if (err) errors.push(`Tool ${t.id}: ${which} schema does not compile (${err})`);
    }
  }

  // Rule 6: recovery
  if (agent.recovery) {
    const rt = agent.recovery.execute?.tool;
    if (rt && !declared(rt)) errors.push(`recovery.execute.tool '${rt}' not declared`);
    const rv = agent.recovery.verify;
    if (rv) {
      if (rv.kind === "effect") checkObserver(rv.observe, "recovery.verify");
      checkRoots(rv.require, verifyRoots(rv), `recovery.verify ${rv.kind}`, errors);
    }
  }

  // Gates
  (agent.gates ?? []).forEach((g, i) => {
    checkRoots(g.when, ROOTS.gate, `gates[${i}].when`, errors);
    checkRoots(g.require, ROOTS.gate, `gates[${i}].require`, errors);
  });

  const cb = agent.counterbalance;
  if (cb) {
    // Rule 7: sequences
    (cb.sequences ?? []).forEach((s, i) => {
      const where = `counterbalance.sequences[${i}]`;
      if (s.action && !declared(s.action)) errors.push(`${where}.action '${s.action}' not declared`);
      for (const t of s.require_prior_tools ?? []) {
        if (!declared(t)) errors.push(`${where}.require_prior_tools: '${t}' not declared`);
      }
      for (const t of s.require_prior_any_of ?? []) {
        if (!declared(t)) errors.push(`${where}.require_prior_any_of: '${t}' not declared`);
      }
      checkRoots(s.require_state, ROOTS.sequence, `${where}.require_state`, errors);
    });
    // Rule 8: invalidate_after
    (cb.invalidate_after ?? []).forEach((r, i) => {
      const where = `counterbalance.invalidate_after[${i}]`;
      if (r.action !== undefined && !declared(r.action)) {
        errors.push(`${where}.action '${r.action}' not declared`);
      }
      for (const k of r.memory_keys ?? []) {
        if (!stateKeys.has(k)) errors.push(`${where}.memory_keys: '${k}' is not a declared state key`);
      }
    });
    // Rule 9: completion
    if (cb.completion) {
      const t = cb.completion.tool;
      if (t && !declared(t)) errors.push(`counterbalance.completion.tool '${t}' not declared`);
      checkRoots(cb.completion.require, ROOTS.completion, "counterbalance.completion.require", errors);
    }
    // Rule 10: checkpoints
    const cpTools = new Set<string>();
    (cb.checkpoints ?? []).forEach((c, i) => {
      const where = `counterbalance.checkpoints[${i}]`;
      const tool = byId.get(c.tool);
      if (!tool) {
        errors.push(`${where}.tool '${c.tool}' not declared`);
      } else if ((tool.channel ?? "world") !== "user") {
        errors.push(`${where}.tool '${c.tool}' must declare channel: user (checkpoints are user decisions)`);
      }
      if (cpTools.has(c.tool)) errors.push(`${where}.tool '${c.tool}' is listed more than once`);
      cpTools.add(c.tool);
      for (const k of c.allow_set_keys ?? []) {
        if (!stateKeys.has(k)) errors.push(`${where}.allow_set_keys: '${k}' is not a declared state key`);
      }
    });
    // Rule 11: provenance keys
    for (const k of Object.keys(cb.memory_provenance ?? {})) {
      if (!stateKeys.has(k)) errors.push(`counterbalance.memory_provenance: '${k}' is not a declared state key`);
    }
    // Rule 12: agent-level output verifies
    (cb.output_verifies ?? []).forEach((v, i) => {
      if (v.kind !== "output") errors.push(`counterbalance.output_verifies[${i}] must be kind: output`);
      checkRoots(v.require, ROOTS.agent_output, `counterbalance.output_verifies[${i}]`, errors);
    });
  }

  // Rule 13: overlays narrow only
  (agent.overlays ?? []).forEach((o, i) => {
    for (const t of o.tools ?? []) {
      if (!permittedSet.has(t) || !declared(t)) {
        errors.push(`overlays[${i}].tools: '${t}' is not in the base permitted set`);
      }
    }
  });

  if (declared(SPAWN_TOOL) && agent.spawn?.allow !== true) {
    warnings.push(`${SPAWN_TOOL} is declared but spawn.allow is not true; every spawn will be denied`);
  }

  return { errors, warnings };
}

export function validateAgent(agent: AgentIR): ValidateResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  // Rule 1: the whole IR is canonical (D3).
  const canon = toCanonical(agent);
  if (!canon.ok) {
    errors.push(`non-canonical value at ${canon.path}: ${canon.problem}`);
    return { ok: false, errors, warnings };
  }

  const validate = contractSchemaValidator();
  if (!validate(agent)) {
    for (const e of validate.errors ?? []) {
      const extra =
        e.keyword === "additionalProperties"
          ? ` ('${String((e.params as { additionalProperty?: string }).additionalProperty)}')`
          : e.keyword === "enum"
            ? ` (${JSON.stringify((e.params as { allowedValues?: unknown }).allowedValues)})`
            : "";
      errors.push(`${e.instancePath || "/"} ${e.message ?? ""}${extra}`.trim());
    }
    // Structural checks assume the schema shape; report schema errors first.
    return { ok: false, errors, warnings };
  }

  const s = structuralChecks(agent);
  errors.push(...s.errors);
  warnings.push(...s.warnings);
  if (errors.length) return { ok: false, errors, warnings };
  return { ok: true, warnings };
}

export function validateAgentPath(
  path: string,
): { ok: true; agent: AgentIR; warnings: string[] } | { ok: false; errors: string[]; warnings: string[] } {
  let agent: AgentIR;
  try {
    if (path.endsWith(".json") || path.endsWith(".yml") || path.endsWith(".yaml")) {
      agent = loadAgentFile(path);
    } else if (existsSync(join(path, "agent.yml"))) {
      agent = loadAgentFile(join(path, "agent.yml"));
    } else if (existsSync(join(path, "agent.json"))) {
      agent = loadAgentFile(join(path, "agent.json"));
    } else {
      return { ok: false, errors: [`Cannot find agent at ${path}`], warnings: [] };
    }
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e.message : String(e)], warnings: [] };
  }
  const v = validateAgent(agent);
  if (!v.ok) return v;
  return { ok: true, agent, warnings: v.warnings };
}
