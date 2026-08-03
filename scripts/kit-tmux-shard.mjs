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
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const ALL_KIT_MODELS = [
  "kit.gemma4-31b-it",
  "kit.minimax-m2.7-229b",
  "kit.qwen3.5-397b-A17b",
  "kit.mistral-small-4-119b-a8b",
];

const MODEL_SHORT = {
  "kit.gemma4-31b-it": "gemma",
  "kit.minimax-m2.7-229b": "minimax",
  "kit.qwen3.5-397b-A17b": "qwen",
  "kit.mistral-small-4-119b-a8b": "mistral",
};

const DEFAULT_PROBE_TASKS = ["01-fix-add", "02-add-multiply"];
const TASK_BAND_A = ["01-fix-add", "02-add-multiply"];
const TASK_BAND_B = ["05-rename-greet", "06-fix-null-guard"];

function parseArgs(argv) {
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
  return out;
}

function shortModel(model) {
  return MODEL_SHORT[model] ?? model.replace(/^kit\./, "").replace(/[^a-z0-9]+/gi, "-");
}

/**
 * Build shard list for a probe ladder level.
 * @param {{ level: number, runIdPrefix: string, tasks: string[]|null, reps: number }} opts
 */
export function buildShards(opts) {
  const tasks = opts.tasks?.length ? opts.tasks : DEFAULT_PROBE_TASKS;
  const { level, runIdPrefix, reps } = opts;
  /** @type {Array<{ session: string, runId: string, models: string[], tasks: string[], reps: number }>} */
  const shards = [];

  if (level === 1) {
    const model = ALL_KIT_MODELS[0];
    shards.push({
      session: `${runIdPrefix}-l1-${shortModel(model)}`,
      runId: `${runIdPrefix}-l1-${shortModel(model)}`,
      models: [model],
      tasks,
      reps,
    });
  } else if (level === 2) {
    for (const model of ALL_KIT_MODELS.slice(0, 2)) {
      shards.push({
        session: `${runIdPrefix}-l2-${shortModel(model)}`,
        runId: `${runIdPrefix}-l2-${shortModel(model)}`,
        models: [model],
        tasks,
        reps,
      });
    }
  } else if (level === 4) {
    for (const model of ALL_KIT_MODELS) {
      shards.push({
        session: `${runIdPrefix}-l3-${shortModel(model)}`,
        runId: `${runIdPrefix}-l3-${shortModel(model)}`,
        models: [model],
        tasks,
        reps,
      });
    }
  } else if (level === 8) {
    for (const model of ALL_KIT_MODELS) {
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
  return [
    `cd ${JSON.stringify(root)}`,
    `export NVM_DIR="$HOME/.nvm"`,
    `[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"`,
    `nvm use >/dev/null`,
    `export PATH="$NVM_DIR/versions/node/$(nvm version)/bin:$PATH"`,
    `[ -f .venv/bin/activate ] && . .venv/bin/activate`,
    `set -a; [ -f .env ] && . ./.env; set +a`,
    `mkdir -p live/reports/kit-probe`,
  ].join(" && ");
}

function shardCommand(shard, opts) {
  const parts = [
    "node scripts/case-study-coding.mjs",
    "--mode live",
    `--manifest ${JSON.stringify(opts.manifest)}`,
    `--kit-models ${shard.models.join(",")}`,
    `--tasks ${shard.tasks.join(",")}`,
    `--reps ${shard.reps}`,
    `--run-id ${shard.runId}`,
    "--resume",
  ];
  if (opts.skipConformance) parts.push("--skip-conformance");
  if (opts.conditions?.length) {
    parts.push(`--conditions ${opts.conditions.join(",")}`);
  }
  const log = `live/reports/kit-probe/${shard.runId}.log`;
  return `${parts.join(" ")} 2>&1 | tee ${JSON.stringify(log)}; echo EXIT:$? | tee -a ${JSON.stringify(log)}`;
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
    const full = `${shellActivate()} && ${shardCommand(shard, opts)}`;
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
async function probeChat(level) {
  loadDotEnvQuiet();
  const key = process.env.KIT_AI_API_KEY;
  if (!key) throw new Error("KIT_AI_API_KEY missing");
  const base = "https://ki-toolbox.scc.kit.edu/api/v1";
  const n = level === 1 ? 1 : level === 2 ? 2 : level === 4 ? 4 : 8;
  const models = [];
  for (let i = 0; i < n; i++) {
    models.push(ALL_KIT_MODELS[i % ALL_KIT_MODELS.length]);
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

function loadDotEnvQuiet() {
  const path = join(root, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function resolveRawDirs(prefix) {
  const candidates = [
    join(root, "live/reports/case-studies/coding-counterbalance"),
    join(root, "live/reports/case-studies/mutable-cells"),
    join(root, "live/reports/case-studies/adversarial"),
    join(root, "live/reports/case-studies/support-policy"),
  ];
  /** @type {string[]} */
  const found = [];
  for (const base of candidates) {
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      if (name.startsWith(prefix) || name.includes(prefix)) {
        found.push(join(base, name));
      }
    }
  }
  // Also direct kit-probe logs
  const probe = join(root, "live/reports/kit-probe");
  if (existsSync(probe)) {
    for (const name of readdirSync(probe)) {
      if (name.startsWith(prefix) && name.endsWith("-shards.json")) {
        found.push(join(probe, name));
      }
    }
  }
  return found;
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

Levels:
  1 → 1 session (gemma)
  2 → 2 sessions (gemma, minimax)
  4 → 4 sessions (all KIT models)
  8 → 8 sessions (4 models × 2 task bands)

Never use with --curriculum / --train-freeze-eval.`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.cmd === "launch") launch(opts);
  else if (opts.cmd === "status") status(opts);
  else if (opts.cmd === "aggregate") aggregate(opts);
  else if (opts.cmd === "chat-probe") await probeChat(opts.level);
  else help();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
