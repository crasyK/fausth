import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { validateAgent, validateAgentPath } from "./validate.js";
import { agentYamlToIr, parseYamlText } from "./load.js";
import type { AgentIR } from "./types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function base(): AgentIR {
  return {
    spec: "counterbalance-contract/v0.1",
    name: "v",
    state: { approved: 0, evidence: 0 },
    tools: [
      { id: "read", read_only: true, input: { type: "object" }, output: { type: "object", additionalProperties: true } },
      { id: "write", input: { type: "object", additionalProperties: true }, output: { type: "object", additionalProperties: true } },
      { id: "ask", channel: "user", input: { type: "object", additionalProperties: true }, output: { type: "object", additionalProperties: true } },
      { id: "done", input: { type: "object" }, output: { type: "object", additionalProperties: true } },
    ],
  };
}

function errorsOf(agent: unknown): string[] {
  const r = validateAgent(agent as AgentIR);
  return r.ok ? [] : r.errors;
}

function expectError(agent: unknown, pattern: RegExp): void {
  const errs = errorsOf(agent);
  assert.ok(errs.some((e) => pattern.test(e)), `expected ${pattern} in ${JSON.stringify(errs)}`);
}

describe("validator (spec-v0.3 §2.6)", () => {
  it("accepts a minimal valid harness", () => {
    assert.deepEqual(errorsOf(base()), []);
  });

  it("SPEC-3: accepts spec ids v0.1, v0.2, v0.3; rejects others", () => {
    for (const v of ["v0.1", "v0.2", "v0.3"]) {
      assert.deepEqual(errorsOf({ ...base(), spec: `counterbalance-contract/${v}` }), []);
    }
    expectError({ ...base(), spec: "counterbalance-contract/v0.4" }, /spec/);
  });

  it("SPEC-3: the agent/world/exchange authoring shape is not loadable", () => {
    expectError({ ...base(), agent: { skills: [] }, world: {}, exchange: {} }, /additional properties/);
  });

  it("CORE-11: the counterbalance block is closed (typo `sequence` is an error, not a dropped rule)", () => {
    expectError({ ...base(), counterbalance: { sequence: [{ action: "write" }] } }, /'sequence'/);
    expectError(
      { ...base(), counterbalance: { orientation: { emit_each_step: true, plan: {} } } },
      /'plan'/,
    );
  });

  it("CORE-11/SPEC-14: invalidate_after needs memory_keys and exactly one of action / ttl_steps", () => {
    expectError({ ...base(), counterbalance: { invalidate_after: [{ action: "write" }] } }, /invalidate_after/);
    expectError(
      { ...base(), counterbalance: { invalidate_after: [{ action: "write", ttl_steps: 2, memory_keys: ["evidence"] }] } },
      /invalidate_after/,
    );
    expectError(
      { ...base(), counterbalance: { invalidate_after: [{ ttl_steps: 2, memory_keys: ["nope"] }] } },
      /'nope' is not a declared state key/,
    );
  });

  it("D11: completion.tool is required and declared (no default task.complete)", () => {
    expectError({ ...base(), counterbalance: { completion: { require: { path: "state.evidence", eq: 1 } } } }, /completion/);
    expectError({ ...base(), counterbalance: { completion: { tool: "task.complete" } } }, /'task.complete' not declared/);
  });

  it("CORE-11: every referenced tool id must be declared", () => {
    expectError({ ...base(), counterbalance: { sequences: [{ action: "nope" }] } }, /action 'nope' not declared/);
    expectError(
      { ...base(), counterbalance: { sequences: [{ action: "write", require_prior_tools: ["ghost"] }] } },
      /'ghost' not declared/,
    );
    expectError(
      { ...base(), recovery: { execute: { tool: "ghost" }, verify: { kind: "evidence", require: { path: "result.ok", eq: 1 } } } },
      /recovery.execute.tool 'ghost'/,
    );
  });

  it("SPEC-16: permissions.tools may not list undeclared tools", () => {
    expectError({ ...base(), permissions: { tools: ["read", "shell.unrestricted"] } }, /'shell.unrestricted' is not a declared tool/);
  });

  it("D14: checkpoint tools must be user-channel tools and own declared keys", () => {
    expectError(
      { ...base(), counterbalance: { checkpoints: [{ tool: "write", allow_set_keys: ["approved"] }] } },
      /must declare channel: user/,
    );
    expectError(
      { ...base(), counterbalance: { checkpoints: [{ tool: "ask", allow_set_keys: ["ghost_key"] }] } },
      /'ghost_key' is not a declared state key/,
    );
    assert.deepEqual(
      errorsOf({ ...base(), counterbalance: { checkpoints: [{ tool: "ask", allow_set_keys: ["approved"] }] } }),
      [],
    );
  });

  it("a failed check can never fall back to allow", () => {
    expectError({ ...base(), gates: [{ require: { path: "state.approved", eq: 1 }, otherwise: "allow" }] }, /otherwise/);
    const a = base();
    a.tools[1]!.verify = [{ kind: "evidence", require: { path: "result.ok", eq: 1 }, otherwise: "allow" as never }];
    expectError(a, /otherwise/);
  });

  it("SPEC-4: tool-level kind: output verifies validate", () => {
    const a = base();
    a.tools[1]!.verify = [{ kind: "output", require: { path: "message.contains_code_fence", eq: 0 }, otherwise: "deny" }];
    assert.deepEqual(errorsOf(a), []);
  });

  it("predicate path roots must exist in their context", () => {
    expectError({ ...base(), gates: [{ require: { path: "result.ok", eq: 1 } }] }, /gates\[0\].require: path 'result.ok'/);
    expectError(
      { ...base(), counterbalance: { completion: { tool: "done", require: { path: "action.args.x", eq: 1 } } } },
      /completion.require: path 'action.args.x'/,
    );
    expectError({ ...base(), gates: [{ require: { path: "states.approved", eq: 1 } }] }, /'states.approved'/);
  });

  it("effect observers must be declared, read_only, world-channel and accept {}", () => {
    const a = base();
    a.tools[1]!.verify = [{ kind: "effect", observe: "write", require: { path: "observation.ok", eq: 1 } }];
    expectError(a, /observer 'write' must have read_only: true/);
    const b = base();
    b.tools[0]!.input = { type: "object", required: ["path"], properties: { path: { type: "string" } } };
    b.tools[1]!.verify = [{ kind: "effect", observe: "read", require: { path: "observation.ok", eq: 1 } }];
    expectError(b, /input schema must accept \{\}/);
  });

  it("D3: the whole IR must be canonical (floats anywhere are rejected with a path)", () => {
    const a = base();
    a.tools[1]!.input = { type: "object", properties: { x: { type: "number", maximum: 1.5 } } };
    expectError(a, /non-canonical value at \$\.tools\[1\]\.input\.properties\.x\.maximum/);
  });

  it("D7: filesystem scopes must normalize", () => {
    expectError({ ...base(), permissions: { filesystem: { write_scopes: ["src/../../etc"] } } }, /escape/);
    expectError({ ...base(), permissions: { filesystem: { read_scopes: ["/abs"] } } }, /absolute/);
  });

  it("overlays may only narrow the permitted set", () => {
    expectError(
      { ...base(), permissions: { tools: ["read"] }, overlays: [{ when_model: "m", tools: ["write"] }] },
      /overlays\[0\].tools: 'write'/,
    );
  });
});

describe("loading (D4, CORE-20)", () => {
  it("YAML 1.2 core schema: yes/no/on/off are strings, 012 is decimal", () => {
    const v = parseYamlText("a: yes\nb: on\nc: 012\nd: No\n") as Record<string, unknown>;
    assert.deepEqual(v, { a: "yes", b: "on", c: 12, d: "No" });
  });

  it("duplicate YAML keys are an error", () => {
    assert.throws(() => parseYamlText("a: 1\na: 2\n"));
  });

  it("unknown top-level YAML keys are carried into the IR and rejected (not silently dropped)", () => {
    const ir = agentYamlToIr(
      parseYamlText(
        "spec: counterbalance-contract/v0.1\nname: t\nstate: {}\ntools: [{id: a}]\ncounterbalnce: {}\n",
      ),
    );
    expectError(ir, /'counterbalnce'/);
  });

  it("JSON harnesses get the same safe_state → fallback_state normalization", () => {
    const dir = mkdtempSync(join(tmpdir(), "fausth-validate-"));
    const p = join(dir, "agent.json");
    writeFileSync(p, JSON.stringify({ ...base(), safe_state: { approved: 0 } }));
    const r = validateAgentPath(p);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(r.agent.fallback_state, { approved: 0 });
      assert.ok(r.warnings.some((w) => /safe_state is deprecated/.test(w)));
    }
  });
});

describe("schemas (SPEC-5, SPEC-6)", () => {
  const schemaDir = join(root, "schema");
  it("no schema file starts with a UTF-8 BOM", () => {
    for (const f of readdirSync(schemaDir).filter((x) => x.endsWith(".json"))) {
      const bytes = readFileSync(join(schemaDir, f));
      assert.ok(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), `${f} has a BOM`);
    }
  });

  it("v0.3 aliases resolve to the executable IR schema", () => {
    const ajv = new Ajv2020({ strict: false });
    for (const f of [
      "counterbalance-contract.v0.1.json",
      "counterbalance-contract.v0.3.json",
      "counterbalance-contract.v0.3.draft.json",
    ]) {
      ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, f), "utf8")));
    }
    const v03 = ajv.getSchema("https://fausth.dev/schema/counterbalance-contract.v0.3.json")!;
    assert.equal(v03({ ...base(), spec: "counterbalance-contract/v0.3" }), true);
    assert.equal(v03({ ...base(), counterbalance: { sequence: [] } }), false);
  });

  it("the v0.2 authoring-shape schema is marked as a non-loadable draft", () => {
    const s = JSON.parse(readFileSync(join(schemaDir, "counterbalance-contract.v0.2.json"), "utf8"));
    assert.equal(s["x-status"], "draft-not-loadable");
    assert.match(s.title, /DRAFT/);
  });
});
