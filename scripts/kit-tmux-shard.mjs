#!/usr/bin/env node
/**
 * Detached tmux sharding for KIT live case-study runs.
 *
 * Parallelism is external: one sequential case-study-coding.mjs process per
 * session, with disjoint --kit-models / --tasks so ledgers never share writers.
 *
 * Usage:
 *   node scripts/kit-tmux-shard.mjs launch --level 1 --run-id-prefix kit-probe-l1
 *   node scripts/kit-tmux-shard.mjs launch --level 4 --run-id-prefix kit-probe-l4 \
 *     --tasks 01-fix-add,02-add-multiply --reps 1
 *   node scripts/kit-tmux-shard.mjs status --run-id-prefix kit-probe-l3
 *   node scripts/kit-tmux-shard.mjs aggregate --run-id-prefix kit-probe-l3
 *
 * Anti-patterns (rejected):
 *   --curriculum / --train-freeze-eval (lineages must stay single-session)
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadDotEnv } from "./lib/env.mjs";
import {
  ALL_KIT_MODELS,
  KIT_BASE_URL,
  assertLiveKitModels,
  shortKitModel,
} from "./lib/kit-models.mjs";
import { repoActivation, shellQuote } from "./lib/shell.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_PROBE_TASKS = ["01-fix-add", "02-add-multiply"];
const TASK_BAND_A = ["01-fix-add", "02-add-multiply"];
const TASK_BAND_B = ["05-rename-greet", "06-fix-null-guard"];

export function parseArgs(argv) {
  const cmd = argv[0] ?? "help";
  const out = {
    cmd,
    level: 1,
    runIdPrefix: "kit-probe",
    tasks: null,
    reps: 1,
    conditions: null,
    manifest: "case-studies/coding-counterbalance/manifest.yml",
    skipConformance: true,
    dryRun: false,
    rawDir: null,
    models: [...ALL_KIT_MODELS],
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--level") out.level = Number(argv[++i]);
    else if (a === "--run-id-prefix") out.runIdPrefix = argv[++i];
    else if (a === "--tasks") {
      out.tasks = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--reps") out.reps = Number(argv[++i]);
    else if (a === "--conditions") {
      out.conditions = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--manifest") out.manifest = argv[++i];
    else if (a === "--raw-dir") out.rawDir = argv[++i];
    else if (a === "--kit-models") {
      out.models = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    }
    else if (a === "--no-skip-conformance") out.skipConformance = false;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--curriculum" || a === "--train-freeze-eval") {
      throw new Error(
        `${a} is not allowed with kit-tmux-shard (lineages must be single-session)`,
      );
    }
  }
  if (![1, 2, 4, 8].includes(out.level) && cmd === "launch") {
    throw new Error(`--level must be 1|2|4|8 (got ${out.level})`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(out.runIdPrefix)) {
    throw new Error(`--run-id-prefix must match [A-Za-z0-9._-]+ (got ${JSON.stringify(out.runIdPrefix)})`);
  }
  if (!out.models.length) throw new Error("--kit-models must name at least one model");
  assertLiveKitModels(out.models, "kit-tmux-shard");
  return out;
}

const shortModel = shortKitModel;

/**
 * Build shard list for a probe ladder level. Shards cycle over `opts.models`
 * (default: every allowed KIT model).
 * @param {{ level: number, runIdPrefix: string, tasks: string[]|null, reps: number, models?: string[] }} opts
 */
export function buildShards(opts) {
  const tasks = opts.tasks?.length ? opts.tasks : DEFAULT_PROBE_TASKS;
  const { level, runIdPrefix, reps } = opts;
  const models = opts.models?.length ? opts.models : ALL_KIT_MODELS;
  /** @type {Array<{ session: string, runId: string, models: string[], tasks: string[], reps: number }>} */
  const shards = [];

  if (level === 1) {
    const model = models[0];
    shards.push({
      session: `${runIdPrefix}-l1-${shortModel(model)}`,
      runId: `${runIdPrefix}-l1-${shortModel(model)}`,
      models: [model],
      tasks,
      reps,
    });
  } else if (level === 2) {
    for (const model of models.slice(0, 2)) {
      shards.push({
        session: `${runIdPrefix}-l2-${shortModel(model)}`,
        runId: `${runIdPrefix}-l2-${shortModel(model)}`,
        models: [model],
        tasks,
        reps,
      });
    }
  } else if (level === 4) {
    for (const model of models) {
      shards.push({
        session: `${runIdPrefix}-l3-${shortModel(model)}`,
        runId: `${runIdPrefix}-l3-${shortModel(model)}`,
        models: [model],
        tasks,
        reps,
      });
    }
  } else if (level === 8) {
    for (const model of models) {
      for (const [bandName, bandTasks] of [
        ["a", opts.tasks?.length ? tasks.slice(0, Math.ceil(tasks.length / 2)) : TASK_BAND_A],
        ["b", opts.tasks?.length ? tasks.slice(Math.ceil(tasks.length / 2)) : TASK_BAND_B],
      ]) {
        if (!bandTasks.length) continue;
        shards.push({
          session: `${runIdPrefix}-l4-${shortModel(model)}-${bandName}`,
          runId: `${runIdPrefix}-l4-${shortModel(model)}-${bandName}`,
          models: [model],
          tasks: bandTasks,
          reps,
        });
      }
    }
  }
  return shards;
}

function shellActivate() {
  return repoActivation(root, { mkdirs: ["live/reports/kit-probe"] });
}

/**
 * Full `bash -lc` command for one shard. Every interpolated value is quoted
 * (SCR-17); pipefail makes `EXIT:` report the runner's status, not tee's, and a
 * failed activation never falls through to the run (SCR-18).
 * @param {{ runId: string, models: string[], tasks: string[], reps: number }} shard
 * @param {{ manifest: string, skipConformance?: boolean, conditions?: string[] | null }} opts
 * @param {string} [activate] shell prelude (defaults to repo + nvm + .venv activation)
 */
export function shardCommand(shard, opts, activate = shellActivate()) {
  const argv = [
    "node",
    "scripts/case-study-coding.mjs",
    "--mode",
    "live",
    "--manifest",
    opts.manifest,
    "--kit-models",
    shard.models.join(","),
    "--tasks",
    shard.tasks.join(","),
    "--reps",
    String(shard.reps),
    "--run-id",
    shard.runId,
    "--resume",
  ];
  if (opts.skipConformance) argv.push("--skip-conformance");
  if (opts.conditions?.length) argv.push("--conditions", opts.conditions.join(","));
  const log = shellQuote(`live/reports/kit-probe/${shard.runId}.log`);
  return `set -o pipefail; ${activate}; ${argv.map(shellQuote).join(" ")} 2>&1 | tee ${log}; echo "EXIT:$?" | tee -a ${log}`;
}

function tmuxExists(session) {
  const r = spawnSync("tmux", ["has-session", "-t", session], { encoding: "utf8" });
  return r.status === 0;
}

function launch(opts) {
  const shards = buildShards(opts);
  const outDir = join(root, "live/reports/kit-probe");
  mkdirSync(outDir, { recursive: true });
  const manifest = {
    created_at: new Date().toISOString(),
    level: opts.level,
    run_id_prefix: opts.runIdPrefix,
    kit_parallel_target: shards.length,
    shards,
    anti_patterns: ["do not share run_id across sessions", "no curriculum fan-out"],
  };
  // Normalize naming: --level 4 → l3 (4-wide), --level 8 → l4 (8-wide)
  const levelTag = opts.level === 1 ? 1 : opts.level === 2 ? 2 : opts.level === 4 ? 3 : 4;
  const path = join(outDir, `${opts.runIdPrefix}-l${levelTag}-shards.json`);
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Wrote ${path} (${shards.length} shards)`);

  for (const shard of shards) {
    const full = shardCommand(shard, opts);
    console.log(`\n=== ${shard.session} ===`);
    console.log(`run_id=${shard.runId} models=${shard.models.join(",")} tasks=${shard.tasks.join(",")}`);
    if (opts.dryRun) {
      console.log(`[dry-run] tmux new-session -d -s ${shard.session}`);
      continue;
    }
    if (tmuxExists(shard.session)) {
      console.warn(`session ${shard.session} already exists — skip (attach or kill first)`);
      continue;
    }
    execFileSync("tmux", ["new-session", "-d", "-s", shard.session, "bash", "-lc", full], {
      cwd: root,
      stdio: "inherit",
    });
    console.log(`started detached session ${shard.session}`);
  }
  console.log(`\nMonitor: tmux ls | grep ${opts.runIdPrefix}`);
  console.log(`Status:  node scripts/kit-tmux-shard.mjs status --run-id-prefix ${opts.runIdPrefix}`);
  return { shards, manifestPath: path };
}

/** Fast concurrent chat probes (auth + one completion) to bound gateway N without full case studies. */
async function probeChat(level, kitModels = ALL_KIT_MODELS) {
  loadDotEnv(join(root, ".env"));
  const key = process.env.KIT_AI_API_KEY;
  if (!key) throw new Error("KIT_AI_API_KEY missing");
  const base = KIT_BASE_URL;
  const n = level === 1 ? 1 : level === 2 ? 2 : level === 4 ? 4 : 8;
  const models = [];
  for (let i = 0; i < n; i++) {
    models.push(kitModels[i % kitModels.length]);
  }
  const started = Date.now();
  const results = await Promise.all(
    models.map(async (model, i) => {
      const t0 = Date.now();
      try {
        const res = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: `Reply with the single word pong-${i}` }],
            max_tokens: 16,
            temperature: 0,
          }),
        });
        const text = await res.text();
        return {
          i,
          model,
          status: res.status,
          ms: Date.now() - t0,
          ok: res.ok,
          rate_limit: res.status === 429,
          body_preview: text.slice(0, 120),
        };
      } catch (e) {
        return {
          i,
          model,
          status: 0,
          ms: Date.now() - t0,
          ok: false,
          rate_limit: false,
          error: String(e?.message || e),
        };
      }
    }),
  );
  const summary = {
    kind: "kit_chat_probe",
    level,
    concurrent: n,
    wall_ms: Date.now() - started,
    ok: results.filter((r) => r.ok).length,
    rate_limit: results.filter((r) => r.rate_limit).length,
    results,
  };
  const out = join(root, "live/reports/kit-probe", `chat-probe-c${n}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Wrote ${out}`);
  return summary;
}

/**
 * Run directories that belong to `prefix`: exactly the run ids recorded in the
 * prefix's shard maps (fallback: names of the form `<prefix>-l<level>-...`).
 * Substring matches are not used — `kit-probe` must not pick up `kit-probe-v2` (SCR-18).
 * @param {string} prefix
 * @param {string} [base] repo root (tests)
 */
export function resolveRawDirs(prefix, base = root) {
  const runsRoot = join(base, "live/reports/case-studies");
  const probe = join(base, "live/reports/kit-probe");
  /** @type {Set<string>} */
  const runIds = new Set();
  /** @type {string[]} */
  const shardMaps = [];
  if (existsSync(probe)) {
    for (const name of readdirSync(probe)) {
      if (new RegExp(`^${escapeRegExp(prefix)}-l\\d+-shards\\.json$`).test(name)) {
        shardMaps.push(join(probe, name));
        try {
          const map = JSON.parse(readFileSync(join(probe, name), "utf8"));
          for (const sh of map.shards ?? []) if (sh.runId) runIds.add(String(sh.runId));
        } catch {
          /* unreadable map */
        }
      }
    }
  }
  const ownName = new RegExp(`^${escapeRegExp(prefix)}-l\\d+-`);
  /** @type {string[]} */
  const found = [];
  if (existsSync(runsRoot)) {
    for (const study of readdirSync(runsRoot)) {
      const studyDir = join(runsRoot, study);
      let names = [];
      try {
        names = readdirSync(studyDir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (runIds.has(name) || (!runIds.size && ownName.test(name))) {
          found.push(join(studyDir, name));
        }
      }
    }
  }
  return [...found.sort(), ...shardMaps.sort()];
}

/** @param {string} s */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadLedger(runDir) {
  const p = join(runDir, "ledger.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function status(opts) {
  const sessions = spawnSync("tmux", ["ls", "-F", "#{session_name}"], {
    encoding: "utf8",
  });
  const names = (sessions.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && s.includes(opts.runIdPrefix));
  console.log(`tmux sessions matching ${opts.runIdPrefix}: ${names.length ? names.join(", ") : "(none)"}`);

  const dirs = resolveRawDirs(opts.runIdPrefix).filter((d) => !d.endsWith(".json"));
  let attempts = 0;
  let infra = 0;
  let rateLimit = 0;
  let scored = 0;
  for (const dir of dirs) {
    const ledger = loadLedger(dir);
    if (!ledger) continue;
    const rows = Array.isArray(ledger) ? ledger : ledger.attempts ?? [];
    for (const a of rows) {
      attempts += 1;
      if (a.status === "infrastructure_failure") {
        infra += 1;
        const msg = String(a.error || a.message || "");
        if (/RATE_LIMIT|429/i.test(msg)) rateLimit += 1;
      }
      if (a.score) scored += 1;
    }
    console.log(`  ${dir}: ${rows.length} ledger rows`);
  }
  const rate = attempts ? rateLimit / attempts : 0;
  console.log(
    JSON.stringify(
      {
        attempts,
        scored,
        infrastructure_failure: infra,
        rate_limit_like: rateLimit,
        rate_limit_rate: rate,
        pass_429_lt_10pct: rate < 0.1,
        active_tmux: names.length,
      },
      null,
      2,
    ),
  );
  return { attempts, infra, rateLimit, rate, active: names.length };
}

function aggregate(opts) {
  const dirs = resolveRawDirs(opts.runIdPrefix).filter((d) => !d.endsWith(".json"));
  /** @type {unknown[]} */
  const all = [];
  for (const dir of dirs) {
    const ledger = loadLedger(dir);
    if (!ledger) continue;
    const rows = Array.isArray(ledger) ? ledger : ledger.attempts ?? [];
    for (const a of rows) all.push({ ...a, _shard_dir: dir });
  }
  const outPath = join(
    root,
    "live/reports/kit-probe",
    `${opts.runIdPrefix}-aggregate.json`,
  );
  mkdirSync(dirname(outPath), { recursive: true });
  const infra = all.filter((a) => a.status === "infrastructure_failure");
  const rateLimit = infra.filter((a) =>
    /RATE_LIMIT|429/i.test(String(a.error || a.message || "")),
  );
  const summary = {
    aggregated_at: new Date().toISOString(),
    run_id_prefix: opts.runIdPrefix,
    n_attempts: all.length,
    infrastructure_failure: infra.length,
    rate_limit_like: rateLimit.length,
    rate_limit_rate: all.length ? rateLimit.length / all.length : 0,
    shards: dirs,
    attempts: all,
  };
  writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n");
  console.log(`Wrote ${outPath} (${all.length} attempts)`);
  return summary;
}

function help() {
  console.log(`kit-tmux-shard — detached KIT case-study sharding

Commands:
  launch     --level 1|2|4|8 --run-id-prefix <id> [--tasks a,b] [--reps N]
  status     --run-id-prefix <id>
  aggregate  --run-id-prefix <id>
  chat-probe --level 1|2|4|8   # concurrent one-shot chat (fast N bound)

Options:
  --kit-models a,b   models to shard over (default: ${ALL_KIT_MODELS.join(", ")})

Levels:
  1 → 1 session (first model)
  2 → 2 sessions (first two models)
  4 → one session per model
  8 → one session per model × 2 task bands

Never use with --curriculum / --train-freeze-eval.`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.cmd === "launch") launch(opts);
  else if (opts.cmd === "status") status(opts);
  else if (opts.cmd === "aggregate") aggregate(opts);
  else if (opts.cmd === "chat-probe") await probeChat(opts.level, opts.models);
  else help();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
