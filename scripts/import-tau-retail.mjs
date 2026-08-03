#!/usr/bin/env node
/**
 * Import τ-bench retail tasks_test into case-studies/tau-bench/tasks.
 *
 * Usage:
 *   node scripts/import-tau-retail.mjs [--cache live/cache/tau/retail_tasks_test.json] [--full]
 *   node scripts/import-tau-retail.mjs --full --write-manifest
 *
 * --full: import all 115 indices (default: stride 0,4,… matching selection.json)
 * Existing task.yml / prompt.md are left untouched (preserves persona answer overrides).
 */
import { createRequire } from "node:module";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(
  join(dirname(fileURLToPath(import.meta.url)), "../engines/ts/package.json"),
);
const { stringify: stringifyYaml } = require("yaml");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROMPT_PREFIX = `# Retail support agent task (τ-bench)

You are a customer-service agent for an online retailer. Follow the policy in \`wiki.md\`.
To call a retail API tool: write JSON to \`tau/request.json\` as \`{"tool":"<name>","kwargs":{...}}\`, then run shell cmd \`tau\`, then read \`tau/response.txt\`.
Read the policy wiki before mutating orders. For returns/exchanges/cancels, clarify with the user via \`user.ask\` first.

## Customer
`;

const DEFAULT_ANSWERS = ["yes", "yes please", "that is correct"];

function parseArgs(argv) {
  const out = {
    cache: "live/cache/tau/retail_tasks_test.json",
    full: false,
    writeManifest: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cache") out.cache = argv[++i];
    else if (argv[i] === "--full") out.full = true;
    else if (argv[i] === "--write-manifest") out.writeManifest = true;
    else if (argv[i] === "--force") out.force = true;
  }
  return out;
}

function padId(index) {
  return `retail-${String(index).padStart(3, "0")}`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cachePath = join(root, opts.cache);
  const tasks = JSON.parse(readFileSync(cachePath, "utf8"));
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error(`empty/invalid cache: ${cachePath}`);
  }

  const indices = opts.full
    ? tasks.map((_, i) => i)
    : Array.from({ length: 25 }, (_, k) => k * 4).filter((i) => i < tasks.length);

  const seedTemplate = join(root, "case-studies/tau-bench/tasks/retail-000/seed");
  const worldData = join(root, "case-studies/tau-bench/world/data");
  const worldTau = join(root, "case-studies/tau-bench/world/tau.mjs");
  const worldWiki = join(root, "case-studies/tau-bench/world/wiki.md");
  if (!existsSync(seedTemplate) && !existsSync(worldData)) {
    throw new Error("missing seed template and world/data");
  }

  const tasksDir = join(root, "case-studies/tau-bench/tasks");
  mkdirSync(tasksDir, { recursive: true });

  let created = 0;
  let skipped = 0;
  const taskIds = [];

  for (const index of indices) {
    const src = tasks[index];
    if (!src) throw new Error(`missing cache entry at index ${index}`);
    const id = padId(index);
    taskIds.push(id);
    const taskDir = join(tasksDir, id);
    const taskYmlPath = join(taskDir, "task.yml");
    const promptPath = join(taskDir, "prompt.md");
    const seedDir = join(taskDir, "seed");

    mkdirSync(taskDir, { recursive: true });

    if (!existsSync(seedDir)) {
      mkdirSync(seedDir, { recursive: true });
      if (existsSync(seedTemplate)) {
        cpSync(seedTemplate, seedDir, { recursive: true });
      } else {
        mkdirSync(join(seedDir, "data"), { recursive: true });
        mkdirSync(join(seedDir, "tau"), { recursive: true });
        cpSync(worldData, join(seedDir, "data"), { recursive: true });
        if (existsSync(worldTau)) cpSync(worldTau, join(seedDir, "tau.mjs"));
        if (existsSync(worldWiki)) cpSync(worldWiki, join(seedDir, "wiki.md"));
      }
    }

    const already = existsSync(taskYmlPath) && existsSync(promptPath);
    if (already && !opts.force) {
      skipped++;
      continue;
    }

    const goldActions = (src.actions || []).map((a) => ({
      name: a.name,
      kwargs: a.kwargs || {},
    }));

    const taskYml = {
      id,
      title: id,
      category: "tau-bench-retail",
      prompt_file: "prompt.md",
      source: {
        benchmark: "tau-bench",
        domain: "retail",
        dataset: "sierra-research/tau-bench",
        index,
        task_id: id,
        user_id: src.user_id,
        annotator: src.annotator ?? null,
      },
      seed: {
        kind: "tau_db",
        dir: "seed",
      },
      grade: {
        kind: "tau_policy",
        gold_actions: goldActions,
        outputs: src.outputs || [],
      },
      user_sim: {
        kind: "scripted",
        answers: [...DEFAULT_ANSWERS],
      },
    };

    writeFileSync(
      taskYmlPath,
      stringifyYaml(taskYml, { lineWidth: 0, defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN" }),
    );
    writeFileSync(
      promptPath,
      `${PROMPT_PREFIX}${(src.instruction || "").trim()}\n`,
    );
    created++;
  }

  const selection = {
    benchmark: "tau-bench",
    domain: "retail",
    source: "sierra-research/tau-bench tasks_test.py",
    n: taskIds.length,
    selection_method: opts.full ? "full_test" : "stride_across_test",
    task_ids: taskIds,
    indices: [...indices],
  };
  const selName = opts.full ? "selection-full.json" : "selection.json";
  const selPath = join(root, "case-studies/tau-bench/instances", selName);
  mkdirSync(dirname(selPath), { recursive: true });
  writeFileSync(selPath, JSON.stringify(selection, null, 2) + "\n");

  if (opts.writeManifest) {
    const basePath = join(root, "case-studies/tau-bench/manifest.yml");
    const base = readFileSync(basePath, "utf8");
    // Keep harness/deployment preamble; replace tasks: block through scoring:
    const head = base.split(/\ntasks:\n/)[0];
    const tailMatch = base.match(/\nscoring:\n[\s\S]*$/);
    if (!tailMatch) throw new Error("manifest.yml missing scoring: block");
    const taskBlock = taskIds
      .map(
        (id) =>
          `  - id: ${id}\n    category: tau-bench-retail\n    path: case-studies/tau-bench/tasks/${id}`,
      )
      .join("\n");
    const outName = opts.full ? "manifest-full-retail.yml" : "manifest.yml";
    const studyNote = opts.full
      ? "study_id: tau-bench-retail-hri-full\n"
      : "";
    let preamble = head;
    if (opts.full) {
      preamble = preamble.replace(
        /study_id: .*/,
        "study_id: tau-bench-retail-hri-full",
      );
      preamble = preamble.replace(/version: .*/, "version: 0.1.0-full");
    }
    writeFileSync(
      join(root, "case-studies/tau-bench", outName),
      `${preamble}\ntasks:\n${taskBlock}\n${tailMatch[0].replace(/^\n/, "")}`,
    );
    console.log(`wrote case-studies/tau-bench/${outName}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        n: taskIds.length,
        created,
        skipped_existing: skipped,
        selection: selName,
        full: opts.full,
      },
      null,
      2,
    ),
  );
}

main();
