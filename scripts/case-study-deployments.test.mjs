/** SCR-4 (KIT deployment materialization) and D14 (user channel bindings). */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  materializeAttemptDeployment,
  materializeKitDeployment,
  resolvePytestCommands,
  resolveUserChannel,
} from "./lib/case-study-deployments.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const YAML = createRequire(join(root, "engines/ts/package.json"))("yaml");

describe("KIT deployment materialization (SCR-4)", () => {
  let runRoot = "";
  before(() => {
    runRoot = mkdtempSync(join(tmpdir(), "fausth-dep-"));
  });
  after(() => rmSync(runRoot, { recursive: true, force: true }));

  it("leaves non-pytest commands untouched (coding / adversarial / mutable manifests)", () => {
    for (const tpl of [
      "case-studies/coding-counterbalance/deployments/local-kit.yml",
      "case-studies/adversarial/deployments/local-kit.yml",
      "case-studies/mutable-cells/deployments/local-kit.yml",
    ]) {
      const v = materializeKitDeployment({ modelId: "kit.glm-5.3-flash", runRoot, templatePath: tpl });
      const dep = YAML.parse(readFileSync(v.abs, "utf8"));
      const original = YAML.parse(readFileSync(join(root, tpl), "utf8"));
      assert.deepEqual(dep.world.commands, original.world.commands, tpl);
      assert.deepEqual(dep.model.models, ["kit.glm-5.3-flash"]);
    }
  });

  it("re-points only literal pytest commands", () => {
    const out = resolvePytestCommands(
      { world: { commands: { test: ["pytest", "-q"], node: ["node", "--test", "x.js"] } } },
      "/abs/pytest-runner.sh",
    );
    assert.deepEqual(out.world.commands.test, ["/abs/pytest-runner.sh", "-q"]);
    assert.deepEqual(out.world.commands.node, ["node", "--test", "x.js"]);
    const swe = materializeKitDeployment({
      modelId: "kit.deepseek-v4-flash",
      runRoot,
      templatePath: "case-studies/swe-bench/deployments/local-kit.yml",
    });
    const dep = YAML.parse(readFileSync(swe.abs, "utf8"));
    assert.match(dep.world.commands.test[0], /pytest/);
    assert.notEqual(dep.world.commands.test[0], "pytest");
  });

  it("is content-hash named and regenerated when the template changes (no stale cache on resume)", () => {
    const tplDir = mkdtempSync(join(tmpdir(), "fausth-tpl-"));
    try {
      const tpl = join(tplDir, "kit.yml");
      writeFileSync(tpl, "model: { models: [x], temperature: 0.7 }\nworld: { commands: { test: [node, --test] } }\n");
      const a = materializeKitDeployment({ modelId: "kit.glm-5.3-flash", runRoot, templatePath: tpl });
      const a2 = materializeKitDeployment({ modelId: "kit.glm-5.3-flash", runRoot, templatePath: tpl });
      assert.equal(a.path, a2.path, "deterministic");
      writeFileSync(tpl, "model: { models: [x], temperature: 0.2 }\nworld: { commands: { test: [node, --test] } }\n");
      const b = materializeKitDeployment({ modelId: "kit.glm-5.3-flash", runRoot, templatePath: tpl });
      assert.notEqual(b.path, a.path);
      assert.equal(YAML.parse(readFileSync(b.abs, "utf8")).model.temperature, 0.2);
    } finally {
      rmSync(tplDir, { recursive: true, force: true });
    }
  });
});

describe("user channel bindings (D14)", () => {
  let dir = "";
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "fausth-uc-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const taskAbsDir = join(root, "case-studies/tau-bench/tasks/retail-000");
  const taskYml = YAML.parse(readFileSync(join(taskAbsDir, "task.yml"), "utf8"));

  it("keeps the base deployment when the manifest declares no user_channel", () => {
    const r = materializeAttemptDeployment({
      basePath: "case-studies/tau-bench/deployments/local-recorded.yml",
      attemptDir: join(dir, "a0"),
      userChannel: null,
      mode: "recorded",
      taskYml,
      taskAbsDir,
      taskId: "retail-000",
    });
    assert.equal(r.user_channel, null);
    assert.equal(r.path, join(root, "case-studies/tau-bench/deployments/local-recorded.yml"));
  });

  it("recorded mode binds user tools to recorded answers outside the workspace", () => {
    const attemptDir = join(dir, "a1");
    const r = materializeAttemptDeployment({
      basePath: "case-studies/tau-bench/deployments/local-recorded.yml",
      attemptDir,
      userChannel: { source: "simulator", model: "kit.glm-5.3-flash" },
      mode: "recorded",
      taskYml,
      taskAbsDir,
      taskId: "retail-000",
    });
    const dep = YAML.parse(readFileSync(r.path, "utf8"));
    assert.deepEqual(dep.bindings["user.ask"], {
      user: { source: "recorded", answers: join(attemptDir, "user-answers.json") },
    });
    assert.deepEqual(JSON.parse(readFileSync(join(attemptDir, "user-answers.json"), "utf8")), [
      "yes",
      "yes please",
      "that is correct",
    ]);
    // Other bindings untouched.
    assert.deepEqual(dep.bindings["tau.invoke"], { native: "local.tau_invoke" });
    assert.deepEqual(r.user_tools, ["user.ask"]);
  });

  it("live simulator binding resolves per-task files and requires a model", () => {
    const ctxDir = join(dir, "ctx");
    mkdirSync(ctxDir, { recursive: true });
    writeFileSync(join(ctxDir, "retail-000.md"), "persona\n");
    const spec = resolveUserChannel({
      userChannel: { source: "simulator", model: "kit.deepseek-v4-flash", context_file: `${ctxDir}/{task_id}.md` },
      mode: "live",
      taskYml,
      taskAbsDir,
      taskId: "retail-000",
      attemptDir: join(dir, "a2"),
    }).spec;
    assert.deepEqual(spec, {
      source: "simulator",
      model: "kit.deepseek-v4-flash",
      context_file: join(ctxDir, "retail-000.md"),
    });
    assert.throws(
      () =>
        resolveUserChannel({
          userChannel: { source: "simulator" },
          mode: "live",
          taskYml,
          taskAbsDir,
          taskId: "retail-000",
          attemptDir: join(dir, "a3"),
        }),
      /requires user_channel.model/,
    );
    assert.throws(
      () =>
        resolveUserChannel({
          userChannel: { source: "oracle" },
          mode: "live",
          taskYml,
          taskAbsDir,
          taskId: "retail-000",
          attemptDir: join(dir, "a4"),
        }),
      /recorded\|simulator\|human/,
    );
  });

  it("leaves user tools unbound (deny) when no answers exist", () => {
    const r = materializeAttemptDeployment({
      basePath: "case-studies/tau-bench/deployments/local-recorded.yml",
      attemptDir: join(dir, "a5"),
      userChannel: { source: "recorded" },
      mode: "recorded",
      taskYml: {},
      taskAbsDir,
      taskId: "retail-000",
    });
    const dep = YAML.parse(readFileSync(r.path, "utf8"));
    assert.equal(dep.bindings["user.ask"], undefined);
    assert.deepEqual(r.user_channel.unbound, ["user.ask"]);
  });
});
