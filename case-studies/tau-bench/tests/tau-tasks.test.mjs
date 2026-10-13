/**
 * τ-bench tasks: format, leakage, gold self-test, split.
 *   node --test case-studies/tau-bench/tests/tau-tasks.test.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as T from "../world/tau.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const study = join(here, "..");
const repoRoot = join(study, "../..");
const require = createRequire(join(repoRoot, "engines/ts/package.json"));
const { parse } = require("yaml");
const tasksDir = join(study, "tasks");
const taskIds = readdirSync(tasksDir).filter((d) => existsSync(join(tasksDir, d, "task.yml"))).sort();
const load = (id) => parse(readFileSync(join(tasksDir, id, "task.yml"), "utf8"));
const upstreamTasks = JSON.parse(readFileSync(join(study, "upstream/tasks-test.json"), "utf8"));
const oracle = JSON.parse(readFileSync(join(study, "upstream/upstream-oracle.json"), "utf8"));

describe("τ tasks: generated, deduplicated, leakage-free", () => {
  it("committed tasks/manifests/split match the importer output (no hand edits)", () => {
    execFileSync(process.execPath, [join(repoRoot, "scripts/import-tau-retail.mjs"), "--check"], { encoding: "utf8" });
  });

  it("all 115 upstream test tasks are present; no per-task seed copies (one canonical world)", () => {
    assert.equal(taskIds.length, 115);
    for (const id of taskIds) {
      assert.equal(existsSync(join(tasksDir, id, "seed")), false, `${id} has a seed/ copy`);
      assert.equal(load(id).seed.dir, "../../world");
      assert.equal(resolve(tasksDir, id, "../../world"), join(study, "world"));
    }
  });

  it("the agent prompt is identical for every task and contains no customer instruction", () => {
    const prompts = new Set(taskIds.map((id) => readFileSync(join(tasksDir, id, "prompt.md"), "utf8")));
    assert.equal(prompts.size, 1);
    const prompt = [...prompts][0];
    assert.doesNotMatch(prompt, /## Customer|You are [A-Z][a-z]+ [A-Z][a-z]+/);
    for (const t of upstreamTasks) {
      // no distinctive fragment of any hidden instruction reaches the agent
      const frag = t.instruction.slice(0, 60);
      assert.ok(!prompt.includes(frag), frag);
      assert.ok(!prompt.includes(t.user_id), t.user_id);
    }
    // the policy (upstream wiki) is the agent's policy, verbatim
    assert.ok(prompt.includes(readFileSync(join(study, "world/wiki.md"), "utf8").trim()));
  });

  it("the hidden instruction lives only in user/instruction.md (simulator context), outside the seed", () => {
    for (const [i, id] of taskIds.entries()) {
      const y = load(id);
      assert.equal(y.user_channel.context_file, "user/instruction.md");
      const ctx = readFileSync(join(tasksDir, id, "user/instruction.md"), "utf8");
      assert.equal(ctx, `Instruction: ${upstreamTasks[i].instruction.trim()}\n`);
      assert.equal(JSON.stringify(y).includes(upstreamTasks[i].instruction.slice(0, 40)), false, "instruction not in task.yml");
    }
    const worldFiles = readdirSync(join(study, "world"));
    assert.deepEqual(worldFiles.sort(), ["data", "tau.mjs", "tools.json", "wiki.md"], "seed holds only world files");
  });

  it("no scripted/hand-written user answers remain; no YAML-1.1 bool hazards", () => {
    for (const id of taskIds) {
      const raw = readFileSync(join(tasksDir, id, "task.yml"), "utf8");
      assert.doesNotMatch(raw, /user_sim|answers:/, id);
      assert.doesNotMatch(raw, /:\s+(yes|no|on|off|y|n)\s*$/im, `${id}: unquoted YAML 1.1 boolean-like scalar`);
    }
  });
});

describe("τ tasks: gold self-test (every task)", () => {
  it("gold replay reproduces the upstream final DB hash; unexpected errors fail loudly", () => {
    let mutating = 0;
    const expectedNoop = [];
    for (const id of taskIds) {
      const y = load(id);
      const data = T.loadSeedData();
      const steps = T.applyGoldActions(data, y.grade.gold_actions);
      const h = T.dataHash(data);
      assert.equal(h, y.grade.expected.final_hash, `${id}: gold replay ≠ upstream`);
      const successfulMutations = steps.filter((s) => s.mutating && !s.error).length;
      if (successfulMutations > 0) {
        mutating += 1;
        assert.notEqual(h, oracle.seed_hash, `${id}: successful mutating gold actions must change the DB`);
        assert.equal(y.grade.expected.db_changes, true);
      } else {
        assert.equal(h, oracle.seed_hash, `${id}: no successful mutation ⇒ unchanged DB`);
        expectedNoop.push(id);
      }
    }
    assert.equal(mutating, 104);
    // info-only / transfer tasks plus upstream tasks whose requested mutation is impossible
    assert.deepEqual(expectedNoop, ["retail-010", "retail-012", "retail-024", "retail-025", "retail-050", "retail-057", "retail-062", "retail-065", "retail-067", "retail-068", "retail-106"]);
  });

  it("every upstream gold error is recorded as an expectation (none are silent)", () => {
    for (const [i, id] of taskIds.entries()) {
      const y = load(id);
      oracle.tasks[i].steps.forEach((st, k) => {
        if (st.skipped_terminate) return;
        assert.equal(Boolean(y.grade.gold_actions[k].expect_error), Boolean(st.error), `${id} action ${k}`);
      });
    }
  });
});

describe("τ split: tuning tasks are never evaluation tasks", () => {
  const split = JSON.parse(readFileSync(join(study, "instances/split.json"), "utf8"));
  const manifestIds = (f) => parse(readFileSync(join(study, f), "utf8")).tasks.map((t) => t.id);

  it("dev and eval partition the 115 tasks; dev holds every task used to tune earlier harnesses", () => {
    assert.equal(split.dev.length + split.eval.length, 115);
    assert.equal(new Set([...split.dev, ...split.eval]).size, 115);
    const tuned = [...Array.from({ length: 25 }, (_, k) => k * 4), 5, 10, 19, 25, 27, 57, 62, 64];
    for (const i of tuned) assert.ok(split.dev.includes(`retail-${String(i).padStart(3, "0")}`), String(i));
    assert.equal(split.seed, 20261013);
    assert.ok(split.eval_sample.every((id) => split.eval.includes(id)));
  });

  it("manifests use exactly their split; the eval manifests contain no dev task", () => {
    assert.deepEqual(manifestIds("manifest.yml"), split.dev);
    assert.deepEqual(manifestIds("manifest-optimize.yml"), split.dev);
    assert.deepEqual(manifestIds("manifest-eval.yml"), split.eval);
    assert.deepEqual(manifestIds("manifest-eval-sample.yml"), split.eval_sample);
    for (const id of taskIds) assert.equal(load(id).split, split.dev.includes(id) ? "dev" : "eval");
  });

  it("manifests declare the user channel and only current KIT models", () => {
    for (const f of ["manifest.yml", "manifest-optimize.yml", "manifest-eval.yml", "manifest-eval-sample.yml", "manifest-full-retail.yml"]) {
      const m = parse(readFileSync(join(study, f), "utf8"));
      assert.equal(m.user_channel.source, "simulator", f);
      assert.equal(m.user_channel.model, "kit.glm-5.3-flash", f);
      assert.ok(existsSync(join(repoRoot, m.user_channel.system_prompt_file)), f);
      assert.equal(m.user_channel.context_file, "{task_dir}/user/instruction.md");
      assert.deepEqual(m.matrix.live_kit_models, ["kit.glm-5.3-flash", "kit.deepseek-v4-flash"]);
      assert.equal(m.deployments.kit.model_id, "kit.glm-5.3-flash");
      assert.ok(!m.outputs.summary.startsWith("case-studies/"), "runs never overwrite tracked results");
    }
  });
});
