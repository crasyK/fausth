#!/usr/bin/env node
/**
 * Import SWE-bench Lite instances into case-studies/swe-bench/tasks (1:1 fields).
 *
 * Usage:
 *   node scripts/import-swe-lite.mjs [--lite live/cache/swe/lite.jsonl] [--n 25] [--selection-only]
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), "../engines/ts/package.json"));
const { stringify: stringifyYaml } = require("yaml");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = {
    lite: "live/cache/swe/lite.jsonl",
    n: 25,
    selectionOnly: false,
    outDir: "case-studies/swe-bench",
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--lite") out.lite = argv[++i];
    else if (argv[i] === "--n") out.n = Number(argv[++i]);
    else if (argv[i] === "--selection-only") out.selectionOnly = true;
    else if (argv[i] === "--out") out.outDir = argv[++i];
  }
  return out;
}

function loadLite(path) {
  const text = readFileSync(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Diversify by repo: round-robin until N.
 * Prefer smaller repos first so flask/seaborn/etc. are represented.
 */
function selectInstances(rows, n) {
  const byRepo = new Map();
  for (const r of rows) {
    if (!byRepo.has(r.repo)) byRepo.set(r.repo, []);
    byRepo.get(r.repo).push(r);
  }
  const repos = [...byRepo.keys()].sort((a, b) => byRepo.get(a).length - byRepo.get(b).length);
  /** @type {typeof rows} */
  const picked = [];
  const idx = Object.fromEntries(repos.map((r) => [r, 0]));
  while (picked.length < n) {
    let progressed = false;
    for (const repo of repos) {
      if (picked.length >= n) break;
      const list = byRepo.get(repo);
      const i = idx[repo];
      if (i < list.length) {
        picked.push(list[i]);
        idx[repo] = i + 1;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return picked;
}

function writeTask(studyDir, row) {
  const taskDir = join(studyDir, "tasks", row.instance_id);
  mkdirSync(taskDir, { recursive: true });

  const prompt = String(row.problem_statement ?? "");
  writeFileSync(join(taskDir, "prompt.md"), prompt.endsWith("\n") ? prompt : prompt + "\n");

  const taskYml = {
    id: row.instance_id,
    title: row.instance_id,
    category: "swe-bench-lite",
    prompt_file: "prompt.md",
    source: {
      benchmark: "SWE-bench_Lite",
      dataset: "princeton-nlp/SWE-bench_Lite",
      split: "test",
      instance_id: row.instance_id,
    },
    repo: row.repo,
    base_commit: row.base_commit,
    version: row.version ?? null,
    environment_setup_commit: row.environment_setup_commit ?? null,
    seed: {
      kind: "git_checkout",
      repo: row.repo,
      base_commit: row.base_commit,
      cache_dir: "live/cache/swe",
    },
    grade: {
      kind: "swe_bench",
      FAIL_TO_PASS: row.FAIL_TO_PASS,
      PASS_TO_PASS: row.PASS_TO_PASS,
    },
    FAIL_TO_PASS: row.FAIL_TO_PASS,
    PASS_TO_PASS: row.PASS_TO_PASS,
    // Gold patch kept for offline oracle / debugging — never seeded into agent worktree.
    gold: {
      patch_sha256: createHash("sha256").update(String(row.patch ?? "")).digest("hex"),
      test_patch_sha256: createHash("sha256").update(String(row.test_patch ?? "")).digest("hex"),
    },
  };

  writeFileSync(join(taskDir, "task.yml"), stringifyYaml(taskYml));
  // Store gold patches outside agent-visible seed
  mkdirSync(join(taskDir, "oracle"), { recursive: true });
  writeFileSync(join(taskDir, "oracle", "patch.diff"), String(row.patch ?? ""));
  writeFileSync(join(taskDir, "oracle", "test_patch.diff"), String(row.test_patch ?? ""));
  if (row.hints_text) {
    writeFileSync(join(taskDir, "oracle", "hints.txt"), String(row.hints_text));
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const litePath = join(root, args.lite);
  if (!existsSync(litePath)) {
    console.error(`missing ${args.lite} — download SWE-bench Lite parquet and convert first`);
    process.exit(1);
  }
  const rows = loadLite(litePath);
  const selected = selectInstances(rows, args.n);
  const studyDir = join(root, args.outDir);
  mkdirSync(join(studyDir, "instances"), { recursive: true });

  const selection = {
    benchmark: "SWE-bench_Lite",
    dataset: "princeton-nlp/SWE-bench_Lite",
    split: "test",
    n: selected.length,
    selection_method: "round_robin_by_repo_ascending_size",
    generated_at: new Date().toISOString(),
    instance_ids: selected.map((r) => r.instance_id),
    by_repo: selected.reduce((acc, r) => {
      acc[r.repo] = (acc[r.repo] ?? 0) + 1;
      return acc;
    }, {}),
    instances: selected.map((r) => ({
      instance_id: r.instance_id,
      repo: r.repo,
      base_commit: r.base_commit,
      version: r.version ?? null,
    })),
  };
  writeFileSync(join(studyDir, "instances/selection.json"), JSON.stringify(selection, null, 2) + "\n");
  console.log(JSON.stringify({ selection: join(args.outDir, "instances/selection.json"), n: selected.length, by_repo: selection.by_repo }, null, 2));

  if (args.selectionOnly) return;

  // Refresh tasks dir for selected ids only
  const tasksRoot = join(studyDir, "tasks");
  mkdirSync(tasksRoot, { recursive: true });
  for (const row of selected) writeTask(studyDir, row);
  console.log(`wrote ${selected.length} tasks under ${args.outDir}/tasks/`);
}

main();
