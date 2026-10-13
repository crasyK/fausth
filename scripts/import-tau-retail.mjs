#!/usr/bin/env node
/**
 * Import τ-bench retail (tasks_test.py, all 115 tasks) into case-studies/tau-bench/tasks.
 *
 * Deterministic: the source is case-studies/tau-bench/upstream/tasks-test.json, derived from
 * sierra-research/tau-bench at the commit pinned in upstream/upstream.lock.json (sha256 of every
 * upstream file and of every derived fixture is checked before anything is written). To refresh
 * the fixtures from upstream, see upstream/make_upstream_oracle.py.
 *
 * Per task it writes:
 *   tasks/retail-NNN/task.yml               gold actions (+ upstream-expected errors), outputs,
 *                                           expected final DB hash, split, user_channel
 *   tasks/retail-NNN/prompt.md              agent-visible prompt — identical for every task
 *                                           (role + policy wiki); NO customer instruction
 *   tasks/retail-NNN/user/instruction.md    hidden instruction for the user simulator only
 * The agent workspace seed is the shared world (`seed.dir: ../../world`), so no per-task DB or
 * tau.mjs copies exist. Also writes instances/split.json and the manifests: manifest.yml (dev,
 * default/CI), manifest-optimize.yml (dev), manifest-eval.yml (held-out), manifest-eval-sample.yml,
 * manifest-full-retail.yml (diagnostic).
 *
 * Usage:
 *   node scripts/import-tau-retail.mjs            # (re)write tasks, split, manifests
 *   node scripts/import-tau-retail.mjs --check    # verify committed files match (CI / tests)
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), "../engines/ts/package.json"));
const { stringify: stringifyYaml } = require("yaml");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const study = join(root, "case-studies/tau-bench");
const upstreamDir = join(study, "upstream");

/** Split seed (recorded in split.json and every manifest). */
export const SPLIT_SEED = 20261013;
/**
 * Tasks used for harness iteration/tuning by earlier (retired) work — the N=25 stride
 * claim set plus the lever-retry tasks. They can never be evaluation tasks again.
 */
export const DEV_INDICES = [
  ...Array.from({ length: 25 }, (_, k) => k * 4),
  5, 10, 19, 25, 27, 57, 62,
].sort((a, b) => a - b);
export const EVAL_SAMPLE_N = 25;

const KIT_MODELS = ["kit.glm-5.3-flash", "kit.deepseek-v4-flash"];
const USER_SIM_MODEL = "kit.glm-5.3-flash";

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function padId(index) {
  return `retail-${String(index).padStart(3, "0")}`;
}

/** mulberry32 — tiny deterministic PRNG for the recorded eval sample. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function computeSplit(n) {
  const dev = DEV_INDICES.filter((i) => i < n);
  const evalIdx = Array.from({ length: n }, (_, i) => i).filter((i) => !dev.includes(i));
  const rand = mulberry32(SPLIT_SEED);
  const shuffled = [...evalIdx];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const sample = shuffled.slice(0, EVAL_SAMPLE_N).sort((a, b) => a - b);
  return { dev, eval: evalIdx, eval_sample: sample };
}

function loadVerifiedUpstream() {
  const lock = JSON.parse(readFileSync(join(upstreamDir, "upstream.lock.json"), "utf8"));
  const derived = lock.derived ?? {};
  for (const [rel, want] of Object.entries(derived)) {
    const got = sha256(readFileSync(join(study, rel)));
    if (got !== want) throw new Error(`fixture ${rel} sha256 ${got} ≠ lock ${want}`);
  }
  const seedFiles = {
    "world/data/orders.json": "tau_bench/envs/retail/data/orders.json",
    "world/data/products.json": "tau_bench/envs/retail/data/products.json",
    "world/data/users.json": "tau_bench/envs/retail/data/users.json",
    "world/wiki.md": "tau_bench/envs/retail/wiki.md",
  };
  for (const [rel, up] of Object.entries(seedFiles)) {
    const got = sha256(readFileSync(join(study, rel)));
    if (got !== lock.files[up]) throw new Error(`${rel} differs from upstream ${up} @ ${lock.commit}`);
  }
  const tasks = JSON.parse(readFileSync(join(upstreamDir, "tasks-test.json"), "utf8"));
  const oracle = JSON.parse(readFileSync(join(upstreamDir, "upstream-oracle.json"), "utf8"));
  if (!Array.isArray(tasks) || tasks.length !== oracle.tasks.length) {
    throw new Error("tasks-test.json / upstream-oracle.json mismatch");
  }
  return { lock, tasks, oracle };
}

export function renderAgentPrompt() {
  const template = readFileSync(join(study, "prompt/agent-prompt.template.md"), "utf8");
  const wiki = readFileSync(join(study, "world/wiki.md"), "utf8").trim();
  return template.replace("{{wiki}}", wiki).trimEnd() + "\n";
}

function taskYml({ index, src, steps, finalHash, seedHash, split, commit }) {
  const gold = src.actions.map((a, i) => {
    const step = steps[i];
    const out = { name: a.name, kwargs: a.kwargs ?? {} };
    if (step?.error) out.expect_error = step.text ?? step.prefix;
    return out;
  });
  return {
    id: padId(index),
    title: padId(index),
    category: "tau-bench-retail",
    prompt_file: "prompt.md",
    split,
    source: {
      benchmark: "tau-bench",
      domain: "retail",
      dataset: "sierra-research/tau-bench tau_bench/envs/retail/tasks_test.py",
      commit,
      index,
      user_id: src.user_id,
      annotator: src.annotator ?? null,
    },
    seed: { kind: "tau_db", dir: "../../world" },
    user_channel: { context_file: "user/instruction.md" },
    grade: {
      kind: "tau_policy",
      gold_actions: gold,
      outputs: src.outputs ?? [],
      expected: {
        final_hash: finalHash,
        db_changes: finalHash !== seedHash,
      },
    },
  };
}

function manifestText({ studyId, version, purpose, indices, split, optimize = false }) {
  const head = {
    study_id: studyId,
    protocol: "docs/case-studies/PROTOCOL.md",
    hri_track: "T",
    version,
    purpose,
    split: {
      file: "case-studies/tau-bench/instances/split.json",
      seed: SPLIT_SEED,
      set: split,
      rule: "dev = tasks used to iterate/tune earlier harnesses (never evaluation tasks); eval = all other test tasks; eval_sample = seeded sample of eval",
    },
    user_channel: {
      source: "simulator",
      model: USER_SIM_MODEL,
      system_prompt_file: "case-studies/tau-bench/deployments/user-sim/system-prompt.md",
      context_file: "{task_dir}/user/instruction.md",
      opening_agent_message: "Hi! How can I help you today?",
      stop_token: "###STOP###",
    },
    harnesses: optimize
      ? {
          counterbalanced: { kind: "single", path: "case-studies/tau-bench/harnesses/counterbalanced" },
          "cb-budget": { kind: "single", path: "case-studies/tau-bench/harnesses/cb-budget" },
          "cb-mutable": { kind: "single", path: "case-studies/tau-bench/harnesses/cb-mutable" },
          "cb-optimize": { kind: "single", path: "case-studies/tau-bench/harnesses/cb-optimize" },
        }
      : {
          counterbalanced: { kind: "single", path: "case-studies/tau-bench/harnesses/counterbalanced" },
          "permissive-control": { kind: "single", path: "case-studies/tau-bench/harnesses/permissive-control" },
        },
    deployments: {
      kit: {
        id: "kit",
        path: "case-studies/tau-bench/deployments/local-kit.yml",
        model_id: KIT_MODELS[0],
        api_key_env: "KIT_AI_API_KEY",
      },
      recorded: {
        id: "recorded",
        path: "case-studies/tau-bench/deployments/local-recorded.yml",
        model_id: "recorded-fixture",
        api_key_env: null,
      },
    },
    matrix: optimize
      ? {
          repetitions: 1,
          max_steps: 30,
          max_task_tries: 5,
          harness_lineage: "never_reset",
          soft_retry_plan: false,
          optimize_on_fail: true,
          optimizer_harness: "case-studies/harness-optimize/agents/optimizer",
          optimizer_deployment: "case-studies/harness-optimize/deployments/local-kit.yml",
          conditions: ["counterbalanced", "cb-budget", "cb-mutable", "cb-optimize"],
          live_deployments: ["kit"],
          live_kit_models: KIT_MODELS,
          recorded_provider_labels: ["kit"],
        }
      : {
          repetitions: 1,
          max_steps: 30,
          conditions: ["counterbalanced", "permissive-control"],
          live_deployments: ["kit"],
          live_kit_models: KIT_MODELS,
          recorded_provider_labels: ["kit"],
        },
    tasks: indices.map((i) => ({
      id: padId(i),
      category: "tau-bench-retail",
      path: `case-studies/tau-bench/tasks/${padId(i)}`,
    })),
    scoring: { path: "case-studies/tau-bench/expected/scoring.yml" },
    outputs: {
      raw_dir: "live/reports/case-studies/tau-bench",
      summary: `live/reports/case-studies/tau-bench/${studyId}.summary.json`,
    },
  };
  return (
    "# GENERATED by scripts/import-tau-retail.mjs — do not edit by hand.\n" +
    "# Reps note: the KIT gateway caches kit.glm-5.3-flash responses by request body, so identical\n" +
    "# requests return identical completions (even at temperature>0): repetitions are NOT independent samples.\n" +
    stringifyYaml(head, { lineWidth: 0 })
  );
}

export function buildAll() {
  const { lock, tasks, oracle } = loadVerifiedUpstream();
  const split = computeSplit(tasks.length);
  const prompt = renderAgentPrompt();
  /** @type {Map<string, string>} relative path → content */
  const files = new Map();
  for (let index = 0; index < tasks.length; index++) {
    const src = tasks[index];
    const o = oracle.tasks[index];
    const dir = `tasks/${padId(index)}`;
    const yml = taskYml({
      index,
      src,
      steps: o.steps,
      finalHash: o.final_hash,
      seedHash: oracle.seed_hash,
      split: split.dev.includes(index) ? "dev" : "eval",
      commit: lock.commit,
    });
    files.set(
      `${dir}/task.yml`,
      "# GENERATED by scripts/import-tau-retail.mjs from upstream/tasks-test.json — do not edit by hand.\n" +
        stringifyYaml(yml, { lineWidth: 0, defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN" }),
    );
    files.set(`${dir}/prompt.md`, prompt);
    // Simulator-only context (upstream build_system_prompt: "Instruction: <instruction>").
    files.set(`${dir}/user/instruction.md`, `Instruction: ${String(src.instruction).trim()}\n`);
  }
  const ids = (xs) => xs.map(padId);
  files.set(
    "instances/split.json",
    JSON.stringify(
      {
        benchmark: "tau-bench",
        domain: "retail",
        source: `sierra-research/tau-bench@${lock.commit} tasks_test.py`,
        n: tasks.length,
        seed: SPLIT_SEED,
        rule: "dev = tasks used for iteration/tuning of earlier harnesses (N=25 stride claim set + lever-retry tasks); eval = remaining test tasks; eval_sample = first 25 of a mulberry32(seed) shuffle of eval, sorted",
        caveat: "All 115 tasks were also run once in the retired full-retail diagnostic (hri-tau-todo-delegate-full-retail); only dev tasks were used to tune.",
        dev: ids(split.dev),
        eval: ids(split.eval),
        eval_sample: ids(split.eval_sample),
      },
      null,
      2,
    ) + "\n",
  );
  files.set(
    "manifest-eval.yml",
    manifestText({
      studyId: "tau-bench-retail-eval",
      version: "0.2.0",
      purpose: "held-out evaluation (all eval-split tasks); CB vs PC differ only in the contract — the only manifest whose results may back a claim",
      indices: split.eval,
      split: "eval",
    }),
  );
  files.set(
    "manifest-eval-sample.yml",
    manifestText({
      studyId: "tau-bench-retail-eval-sample",
      version: "0.2.0",
      purpose: "cheaper held-out comparison on the seeded eval sample (N=25)",
      indices: split.eval_sample,
      split: "eval_sample",
    }),
  );
  files.set(
    "manifest.yml",
    manifestText({
      studyId: "tau-bench-retail-dev",
      version: "0.2.0",
      purpose: "DEFAULT = dev split: harness iteration and CI fixtures only — never report these results as evaluation (use manifest-eval.yml)",
      indices: split.dev,
      split: "dev",
    }),
  );
  files.set(
    "manifest-optimize.yml",
    manifestText({
      studyId: "tau-bench-retail-opt-arms-dev",
      version: "0.2.0",
      purpose: "optimizer / lever arms — tuning happens here, so dev split only",
      indices: split.dev,
      split: "dev",
      optimize: true,
    }),
  );
  files.set(
    "manifest-full-retail.yml",
    manifestText({
      studyId: "tau-bench-retail-full",
      version: "0.2.0",
      purpose: "diagnostic run over all 115 test tasks (mixes dev and eval; never a headline)",
      indices: Array.from({ length: tasks.length }, (_, i) => i),
      split: "all",
    }),
  );
  return { files, split, n: tasks.length };
}

function main() {
  const check = process.argv.includes("--check");
  const { files, split, n } = buildAll();
  const drift = [];
  for (const [rel, content] of files) {
    const p = join(study, rel);
    if (check) {
      if (!existsSync(p) || readFileSync(p, "utf8") !== content) drift.push(rel);
      continue;
    }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  const legacy = [];
  for (const d of readdirSync(join(study, "tasks"))) {
    const seedDir = join(study, "tasks", d, "seed");
    if (existsSync(seedDir)) {
      legacy.push(`tasks/${d}/seed`);
      if (!check) rmSync(seedDir, { recursive: true, force: true });
    }
  }
  if (check) {
    if (drift.length || legacy.length) {
      console.error(JSON.stringify({ ok: false, drift: drift.slice(0, 20), drift_n: drift.length, legacy_seed_dirs: legacy.length }, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, files: files.size }));
    return;
  }
  console.log(
    JSON.stringify(
      { ok: true, tasks: n, dev: split.dev.length, eval: split.eval.length, eval_sample: split.eval_sample.length, removed_seed_dirs: legacy.length },
      null,
      2,
    ),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
