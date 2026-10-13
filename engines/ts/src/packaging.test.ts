import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, rmSync } from "node:fs";
import {
  evaluateFixtureFitness,
  inspectHarness,
  packHarness,
  securityCellChanges,
  selectHarness,
  testHarness,
} from "./packaging.js";
import type { AgentIR, HarnessPatch } from "./types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const harness = join(root, "examples/coding-counterbalance");

describe("packaging", () => {
  it("inspects coding-counterbalance", () => {
    const r = inspectHarness(harness);
    assert.equal(r.name, "coding-counterbalance-slice");
    assert.ok(r.tools.includes("fs.write_scoped"));
    assert.ok(r.deployments.length >= 2);
    assert.equal(r.binding_coverage?.ok, true);
  });

  it("tests coding-counterbalance smoke + fixtures", async () => {
    const r = await testHarness(harness);
    assert.equal(r.validate_ok, true);
    assert.equal(r.bindings_ok, true);
    assert.equal(r.smoke_ok, true);
    assert.equal(r.ok, true);
  });

  it("tests support-bot smoke + fixtures", async () => {
    const support = join(root, "examples/support-bot");
    const r = await testHarness(support);
    assert.equal(r.validate_ok, true);
    assert.equal(r.bindings_ok, true);
    assert.equal(r.smoke_ok, true);
    assert.equal(r.ok, true);
  });

  it("packs coding-counterbalance bundle", () => {
    const outDir = join(harness, "dist");
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
    const { out, files } = packHarness(harness);
    assert.ok(out.endsWith("coding-counterbalance.fausth.json"));
    assert.ok(files.includes("agent.yml"));
    assert.ok(files.some((f) => f.startsWith("deployment.")));
    rmSync(outDir, { recursive: true, force: true });
  });
});

describe("selection gate (PY-20)", () => {
  const fixtures = join(root, "conformance/fixtures");
  const mutable = join(root, "examples/mutable-skills");
  const patch = JSON.parse(readFileSync(join(mutable, "patch-skills.json"), "utf8")) as HarnessPatch;

  it("runs the patched harness against recorded transcripts and reports per-fixture fitness", async () => {
    const r = await selectHarness(mutable, patch, { fixturesRoot: fixtures });
    assert.equal(r.ok, true, r.errors.join("\n"));
    assert.equal(r.security_ok, true);
    assert.equal(r.fitness_evaluated, true);
    assert.ok(r.fixtures.length >= 3);
    for (const f of r.fixtures) {
      assert.equal(f.replayable, true, f.fixture);
      assert.equal(f.candidate_pass, true, f.fixture);
      assert.deepEqual(f.candidate.denies, f.baseline.denies);
    }
    assert.notEqual(r.harness_hash_after, r.harness_hash_before);
    assert.equal(
      r.patched_agent?.tools.find((t) => t.id === "fs.read")?.description,
      "Read a scoped source file carefully",
    );
  });

  it("skip-fixtures is reported as NOT fitness-tested", async () => {
    const r = await selectHarness(mutable, patch, { fixturesRoot: fixtures, skipFixtures: true });
    assert.equal(r.ok, true);
    assert.equal(r.fitness_evaluated, false);
    assert.ok(r.details.some((d) => /NOT fitness-tested/.test(d)));
  });

  it("flags any change outside the mutable cells as a security-cell change", () => {
    const before = JSON.parse(
      readFileSync(join(fixtures, "cb-harness-patch-skills-ok/agent.json"), "utf8"),
    ) as AgentIR;
    const widened = structuredClone(before);
    widened.permissions = { ...(widened.permissions ?? {}), tools: [...(widened.permissions?.tools ?? []), "shell.run"] };
    assert.deepEqual(securityCellChanges(before, widened), ["security cell changed: permissions"]);
    const described = structuredClone(before);
    described.tools[0]!.description = "new skill text";
    assert.deepEqual(securityCellChanges(before, described), []);
    const notMutable = structuredClone(before);
    notMutable.mutable = [];
    const notMutableAfter = structuredClone(notMutable);
    notMutableAfter.instinct_text = "be bold";
    assert.deepEqual(securityCellChanges(notMutable, notMutableAfter), [
      "cell not mutable: instincts (instinct_text changed)",
    ]);
  });

  it("rejects a candidate that loses a deny the baseline had on the same transcript", async () => {
    const dir = join(fixtures, "deny-fan-over-80");
    const baseline = JSON.parse(readFileSync(join(dir, "agent.json"), "utf8")) as AgentIR;
    const candidate = structuredClone(baseline);
    candidate.gates = [];
    const f = await evaluateFixtureFitness(dir, baseline, candidate);
    assert.equal(f.replayable, true);
    assert.equal(f.candidate_pass, false);
    assert.ok(f.reasons.some((r) => r.startsWith("lost 1× deny|authorize|actuator.fan.set|")), f.reasons.join("; "));
    const same = await evaluateFixtureFitness(dir, baseline, structuredClone(baseline));
    assert.equal(same.candidate_pass, true);
  });
});
