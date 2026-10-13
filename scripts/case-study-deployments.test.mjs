/** SCR-4 (KIT deployment materialization) and D14 (user channel bindings). */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  answerEnvelope,
  declaredUserChannelTools,
  materializeAttemptDeployment,
  materializeKitDeployment,
  resolvePytestCommands,
  resolveUserChannel,
} from "./lib/case-study-deployments.mjs";
import { bootstrapWorkspace, cleanupWorkspace } from "./lib/workspace.mjs";

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
  const tauDep = "case-studies/tau-bench/deployments/local-recorded.yml";
  const askDef = {
    id: "user.ask",
    output: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } },
  };

  it("keeps the base deployment when the attempt has no user-channel tools", () => {
    const r = materializeAttemptDeployment({
      basePath: "case-studies/coding-counterbalance/deployments/local-recorded.yml",
      attemptDir: join(dir, "a0"),
      userChannel: null,
      mode: "recorded",
      taskYml,
      taskAbsDir,
      taskId: "retail-000",
    });
    assert.equal(r.user_channel, null);
    assert.equal(r.path, join(root, "case-studies/coding-counterbalance/deployments/local-recorded.yml"));
  });

  it("rebinds removed auto-answer natives to recorded scripted answers (engine JSONL, relative path)", () => {
    const attemptDir = join(dir, "a1");
    const r = materializeAttemptDeployment({
      basePath: tauDep,
      attemptDir,
      userChannel: null,
      mode: "live",
      taskYml,
      taskAbsDir,
      taskId: "retail-000",
      toolDefs: { "user.ask": askDef },
      maxCalls: 5,
    });
    const dep = YAML.parse(readFileSync(r.path, "utf8"));
    assert.deepEqual(dep.bindings["user.ask"], {
      user: { source: "recorded", answers: "user-answers.user.ask.jsonl" },
    });
    assert.equal(dirname(r.path), attemptDir, "answers resolve next to the deployment");
    const lines = readFileSync(join(attemptDir, "user-answers.user.ask.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.deepEqual(
      lines.map((l) => [l.tool, l.call_seq, l.result.output.answer]),
      [
        ["user.ask", 1, "yes"],
        ["user.ask", 2, "yes please"],
        ["user.ask", 3, "that is correct"],
        ["user.ask", 4, "that is correct"],
        ["user.ask", 5, "that is correct"],
      ],
    );
    assert.deepEqual(dep.bindings["tau.invoke"], { native: "local.tau_invoke" }, "other bindings untouched");
    assert.equal(r.user_channel["user.ask"].scripted_answers, 3);
  });

  it("recorded mode never binds a live simulator", () => {
    const r = materializeAttemptDeployment({
      basePath: tauDep,
      attemptDir: join(dir, "a2"),
      userChannel: { source: "simulator", model: "kit.glm-5.3-flash" },
      mode: "recorded",
      taskYml,
      taskAbsDir,
      taskId: "retail-000",
      toolDefs: { "user.ask": askDef },
    });
    assert.equal(YAML.parse(readFileSync(r.path, "utf8")).bindings["user.ask"].user.source, "recorded");
  });

  it("live simulator binding copies per-task files next to the deployment", () => {
    const ctxDir = join(dir, "ctx");
    mkdirSync(ctxDir, { recursive: true });
    writeFileSync(join(ctxDir, "retail-000.md"), "persona goal\n");
    writeFileSync(join(ctxDir, "sim.md"), "You are the customer.\n");
    const attemptDir = join(dir, "a3");
    const r = materializeAttemptDeployment({
      basePath: tauDep,
      attemptDir,
      userChannel: {
        source: "simulator",
        model: "kit.deepseek-v4-flash",
        system_prompt_file: `${ctxDir}/sim.md`,
        context_file: `${ctxDir}/{task_id}.md`,
        max_tokens: 256,
      },
      mode: "live",
      taskYml,
      taskAbsDir,
      taskId: "retail-000",
    });
    const spec = YAML.parse(readFileSync(r.path, "utf8")).bindings["user.ask"].user;
    assert.deepEqual(spec, {
      source: "simulator",
      model: "kit.deepseek-v4-flash",
      system_prompt_file: "user-sim.user.ask.system.md",
      context_file: "user-sim.user.ask.context.md",
      max_tokens: 256,
    });
    assert.equal(readFileSync(join(attemptDir, spec.context_file), "utf8"), "persona goal\n");
    assert.throws(
      () =>
        resolveUserChannel({
          tool: "user.ask",
          userChannel: { source: "simulator" },
          baseDir: dir,
          mode: "live",
          taskYml,
          taskAbsDir,
          taskId: "retail-000",
          attemptDir: join(dir, "a4"),
        }),
      /requires user_channel.model/,
    );
    assert.throws(
      () =>
        resolveUserChannel({
          tool: "user.ask",
          userChannel: { source: "oracle" },
          baseDir: dir,
          mode: "live",
          taskYml,
          taskAbsDir,
          taskId: "retail-000",
          attemptDir: join(dir, "a5"),
        }),
      /recorded\|simulator\|human/,
    );
  });

  it("leaves user tools unbound (deny) when no answers exist", () => {
    const r = materializeAttemptDeployment({
      basePath: tauDep,
      attemptDir: join(dir, "a6"),
      userChannel: null,
      mode: "recorded",
      taskYml: {},
      taskAbsDir,
      taskId: "retail-000",
    });
    const dep = YAML.parse(readFileSync(r.path, "utf8"));
    assert.equal(dep.bindings["user.ask"], undefined);
    assert.equal(r.user_channel["user.ask"].unbound, true);
  });

  it("maps scripted answers onto non-string output schemas or refuses", () => {
    assert.deepEqual(
      answerEnvelope({ output: { type: "object", required: ["approved"], properties: { approved: { type: "integer" } } } }, "yes"),
      { output: { approved: 1 } },
    );
    assert.equal(
      answerEnvelope({ output: { type: "object", required: ["a", "b"], properties: {} } }, "yes"),
      null,
    );
    assert.deepEqual(answerEnvelope(askDef, { output: { answer: "x" } }), { output: { answer: "x" } });
  });

  it("checkpoint tools on the user channel keep the auto-checkpoint protocol as recorded scripts", () => {
    const attemptDir = join(dir, "cp");
    const r = materializeAttemptDeployment({
      basePath: "case-studies/coding-counterbalance/deployments/local-recorded.yml",
      attemptDir,
      userChannel: { recorded: { "user.approve": [{ output: { approved: 1 } }] } },
      mode: "recorded",
      taskYml: {},
      taskAbsDir,
      taskId: "01-fix-add",
      declaredUserTools: ["user.correct", "user.approve"],
      maxCalls: 2,
    });
    const dep = YAML.parse(readFileSync(r.path, "utf8"));
    assert.deepEqual(dep.bindings["user.correct"], {
      user: { source: "recorded", answers: "user-answers.user.correct.jsonl" },
    });
    const read = (f) =>
      readFileSync(join(attemptDir, f), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
    assert.deepEqual(read("user-answers.user.correct.jsonl"), [
      { tool: "user.correct", call_seq: 1, result: { output: { ok: 1 }, state_transition: { set: { open_todos: 0 } } } },
      { tool: "user.correct", call_seq: 2, result: { output: { ok: 1 }, state_transition: { set: { open_todos: 0 } } } },
    ]);
    // Manifest inline scripts win over the legacy translation.
    assert.deepEqual(read("user-answers.user.approve.jsonl")[0].result, { output: { approved: 1 } });
    assert.deepEqual(dep.bindings["fs.read"], { native: "local.fs_read" });
  });

  /** Generated deployment + scripted answers for the τ counterbalanced harness. */
  function tauAttempt(name) {
    const attemptDir = join(dir, name);
    const r = materializeAttemptDeployment({
      basePath: tauDep,
      attemptDir,
      userChannel: null,
      mode: "recorded",
      taskYml,
      taskAbsDir,
      taskId: "retail-000",
      toolDefs: { "user.ask": askDef },
      maxCalls: 4,
    });
    return { attemptDir, deploymentPath: r.path };
  }

  it("the engine's user-channel adapter answers user.ask in order from the generated binding", () => {
    const { deploymentPath } = tauAttempt("adapter");
    const ws = bootstrapWorkspace({ seed: join(taskAbsDir, "seed"), root: join(dir, "ws-root") });
    try {
      const probe = `
        import { readFileSync } from "node:fs";
        import { parse } from "yaml";
        import { loadAgentDir } from ${JSON.stringify(join(root, "engines/ts/src/load.ts"))};
        import { resolveToolsFromDeployment } from ${JSON.stringify(join(root, "engines/ts/src/adapters/registry.ts"))};
        const harnessDir = ${JSON.stringify(join(root, "case-studies/tau-bench/harnesses/counterbalanced"))};
        const { agent } = loadAgentDir(harnessDir);
        const dep = parse(readFileSync(${JSON.stringify(deploymentPath)}, "utf8"));
        const tools = resolveToolsFromDeployment(agent, dep, {
          workspace: ${JSON.stringify(ws.worktree)},
          harnessDir,
          deploymentPath: ${JSON.stringify(deploymentPath)},
        });
        const ctx = { state: { ...agent.state } };
        const out = [];
        for (const q of ["Exchange both items?", "Use credit_card_9513926?"]) {
          out.push((await tools["user.ask"]({ question: q }, ctx)).output.answer);
        }
        console.log(JSON.stringify(out));
      `;
      const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], {
        cwd: join(root, "engines/ts"),
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout.trim().split("\n").pop()), ["yes", "yes please"]);
    } finally {
      cleanupWorkspace({ worktree: ws.worktree, root: join(dir, "ws-root") });
    }
  });

  /**
   * τ counterbalanced harness with its user-facing tools declared on the user
   * channel (contract v0.3 §8.3/§9), copied outside the repo so the test does not
   * depend on when the case-study harnesses are migrated.
   */
  function userChannelHarness() {
    const h = join(dir, "harness-v03");
    mkdirSync(h, { recursive: true });
    let yml = readFileSync(join(root, "case-studies/tau-bench/harnesses/counterbalanced/agent.yml"), "utf8");
    for (const tool of ["user.ask", "user.correct"]) {
      yml = yml.replace(new RegExp(`(\\n  - id: ${tool.replace(".", "\\.")}\\n)(?!    channel:)`), `$1    channel: user\n`);
    }
    writeFileSync(join(h, "agent.yml"), yml);
    return h;
  }

  it("the engine CLI answers user.ask in order from the generated binding", () => {
      const harness = userChannelHarness();
      const attemptDir = join(dir, "cli");
      const { path: deploymentPath } = materializeAttemptDeployment({
        basePath: tauDep,
        attemptDir,
        userChannel: null,
        mode: "recorded",
        taskYml,
        taskAbsDir,
        taskId: "retail-000",
        declaredUserTools: declaredUserChannelTools(harness),
        toolDefs: { "user.ask": askDef },
        maxCalls: 4,
      });
      const trace = join(attemptDir, "model.jsonl");
      writeFileSync(
        trace,
        [
          { type: "tool", name: "user.ask", args: { question: "Exchange both items?" } },
          { type: "tool", name: "user.ask", args: { question: "Use credit_card_9513926?" } },
          { type: "stop" },
        ]
          .map((x) => JSON.stringify(x))
          .join("\n") + "\n",
      );
      const ws = bootstrapWorkspace({ seed: join(taskAbsDir, "seed"), root: join(dir, "ws-root") });
      try {
        const dump = join(attemptDir, "events.jsonl");
        const run = spawnSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "src/cli.ts",
            "run",
            harness,
            "--deployment",
            deploymentPath,
            "--workspace",
            ws.worktree,
            "--model",
            trace,
            "--max-steps",
            "6",
            "--dump",
            dump,
          ],
          { cwd: join(root, "engines/ts"), encoding: "utf8" },
        );
        assert.equal(run.status, 0, run.stderr);
        const answers = readFileSync(dump, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
          .filter((e) => e.stage === "execute" && e.tool === "user.ask" && e.verdict === "allow")
          .map((e) => e.result?.answer);
        assert.deepEqual(answers, ["yes", "yes please"]);
        // user.correct is a checkpoint on the user channel: answered by the recorded
        // auto-correct script, never by a native.
        const dep = YAML.parse(readFileSync(deploymentPath, "utf8"));
        assert.equal(dep.bindings["user.correct"].user.source, "recorded");
      } finally {
        cleanupWorkspace({ worktree: ws.worktree, root: join(dir, "ws-root") });
      }
  });
});
