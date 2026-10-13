/**
 * τ harnesses: CB and PC differ only in the contract; every rule is real.
 *   node --test case-studies/tau-bench/tests/tau-harnesses.test.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const study = join(here, "..");
const repoRoot = join(study, "../..");
const require = createRequire(join(repoRoot, "engines/ts/package.json"));
const { parse } = require("yaml");
const h = (name) => parse(readFileSync(join(study, "harnesses", name, "agent.yml"), "utf8"));

describe("τ harnesses", () => {
  it("are generated (no drift from harnesses/generate.mjs)", () => {
    execFileSync(process.execPath, [join(study, "harnesses/generate.mjs"), "--check"]);
  });

  it("CB and PC expose the identical tool surface (ids, descriptions, schemas, verifies)", () => {
    const cb = h("counterbalanced");
    const pc = h("permissive-control");
    assert.deepEqual(pc.tools, cb.tools);
    assert.deepEqual(pc.permissions, cb.permissions);
    assert.deepEqual(pc.limits, cb.limits);
    assert.deepEqual(pc.state, cb.state);
    assert.deepEqual(pc.counterbalance.checkpoints, cb.counterbalance.checkpoints, "same user-channel authority ⇒ same simulator prompt");
    // the contract difference is exactly the confirm-before-mutate rule
    assert.equal(pc.counterbalance.sequences, undefined);
    assert.deepEqual(cb.counterbalance.sequences.map((s) => s.id), ["confirm-before-mutate"]);
    assert.deepEqual(cb.counterbalance.invalidate_after, [{ action: "tau.invoke", memory_keys: ["clarified"] }]);
  });

  it("the agent has no filesystem access (DB changes only through world tools)", () => {
    for (const name of ["counterbalanced", "permissive-control", "cb-budget", "cb-mutable", "cb-optimize", "cb-tau-native"]) {
      const ir = h(name);
      assert.deepEqual(ir.permissions.filesystem.write_scopes, [], name);
      assert.ok(!ir.tools.some((t) => t.id.startsWith("fs.") || t.id.startsWith("shell.")), name);
      assert.ok(!ir.tools.some((t) => t.id === "user.correct"), `${name}: no self-authored corrections`);
    }
  });

  it("every state key is used by a real rule; user tools are user-channel; tool catalog is upstream's", () => {
    const cb = h("counterbalanced");
    // clarified is the only key any rule reads; the other two exist only because the engine's
    // τ host still writes them on every successful call (declared so calls are not rejected)
    assert.deepEqual(Object.keys(cb.state), ["clarified", "researched", "test_evidence_current"]);
    const rules = JSON.stringify(cb.counterbalance);
    assert.ok(!rules.includes("researched") && !rules.includes("test_evidence_current"));
    const ask = cb.tools.find((t) => t.id === "user.ask");
    assert.equal(ask.channel, "user");
    const tau = cb.tools.find((t) => t.id === "tau.invoke");
    const upstream = JSON.parse(readFileSync(join(study, "world/tools.json"), "utf8"));
    assert.deepEqual(tau.input.properties.tool.enum, upstream.map((s) => s.function.name));
    for (const s of upstream) assert.ok(tau.description.includes(s.function.description), s.function.name);
  });

  it("deployments bind user.ask to the user channel (simulator / recorded), never to auto-yes", () => {
    for (const f of ["local-kit.yml", "local-recorded.yml"]) {
      const d = parse(readFileSync(join(study, "deployments", f), "utf8"));
      assert.ok(d.bindings["user.ask"].user, f);
      assert.equal(d.bindings["user.ask"].native, undefined, f);
      assert.equal(d.bindings["user.correct"], undefined, f);
      assert.equal(d.world.scopes, undefined, `${f}: scopes come from the harness`);
      assert.deepEqual(Object.keys(d.world.commands), ["tau"]);
    }
    const kit = parse(readFileSync(join(study, "deployments/local-kit.yml"), "utf8"));
    assert.deepEqual(kit.model.models, ["kit.glm-5.3-flash", "kit.deepseek-v4-flash"]);
    assert.equal(kit.bindings["user.ask"].user.model, "kit.glm-5.3-flash");
  });

  it("user-simulator persona carries upstream's rules verbatim", () => {
    const persona = readFileSync(join(study, "deployments/user-sim/system-prompt.md"), "utf8");
    for (const rule of [
      "- Just generate one line at a time to simulate the user's message.",
      "- If the instruction goal is satisified, generate '###STOP###' as a standalone message without anything else to end the conversation.",
      "- Try to make the conversation as natural as possible, and stick to the personalities in the instruction.",
    ]) {
      assert.ok(persona.includes(rule), rule);
    }
  });
});
