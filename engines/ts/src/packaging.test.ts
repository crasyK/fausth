import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, rmSync } from "node:fs";
import { inspectHarness, packHarness, testHarness } from "./packaging.js";

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
