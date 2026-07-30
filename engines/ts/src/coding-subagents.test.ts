import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(join(root, "engines/ts/package.json"));
const { parse: parseYaml } = require("yaml");

function loadAgent(rel) {
  return parseYaml(readFileSync(join(root, rel, "agent.yml"), "utf8"));
}

describe("coding subagent harnesses", () => {
  it("research tools exclude write/shell/complete", () => {
    const a = loadAgent("examples/coding-counterbalance/agents/research");
    const ids = a.tools.map((t) => t.id).sort();
    assert.deepEqual(ids, ["fs.list", "fs.read", "phase.yield", "user.correct"]);
    assert.equal(a.counterbalance?.modes, undefined);
  });

  it("plan tools exclude write/shell/complete", () => {
    const a = loadAgent("examples/coding-counterbalance/agents/plan");
    const ids = a.tools.map((t) => t.id).sort();
    assert.deepEqual(ids, ["fs.list", "fs.read", "phase.yield", "user.approve", "user.correct"].sort());
    assert.ok(ids.includes("user.approve"));
    assert.ok(!ids.includes("fs.write_scoped"));
  });

  it("implementation has write/shell/complete and no mode.enter", () => {
    const a = loadAgent("examples/coding-counterbalance/agents/implementation");
    const ids = new Set(a.tools.map((t) => t.id));
    assert.ok(ids.has("fs.list"));
    assert.ok(ids.has("fs.write_scoped"));
    assert.ok(ids.has("shell.run_allowlisted"));
    assert.ok(ids.has("task.complete"));
    assert.ok(!ids.has("mode.enter"));
    assert.ok(!ids.has("phase.yield"));
    assert.equal(a.counterbalance?.completion?.tool, "task.complete");
  });

  it("permissive is a single open harness without modes", () => {
    const a = loadAgent(
      "case-studies/coding-counterbalance/harnesses/permissive-control",
    );
    assert.equal(a.counterbalance?.modes, undefined);
    const ids = new Set(a.tools.map((t) => t.id));
    assert.ok(ids.has("fs.list"));
    assert.ok(ids.has("fs.write_scoped"));
    assert.ok(ids.has("task.complete"));
    assert.ok(!ids.has("mode.enter"));
  });
});
