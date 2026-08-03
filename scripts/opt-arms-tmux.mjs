#!/usr/bin/env node
/**
 * Detached tmux launcher for S/T harness-optimization parallel arms.
 * One session per (track × arm) = 8 sessions, all in parallel (KIT N=8).
 * Never shards mutable/optimize across sessions (never-reset lineage).
 *
 *   node scripts/opt-arms-tmux.mjs launch
 *   node scripts/opt-arms-tmux.mjs launch --dry-run
 *   node scripts/opt-arms-tmux.mjs status
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Run-id prefix: --run-prefix <v> or OPT_ARMS_RUN_PREFIX env, default v2.
const RUN_PREFIX = (() => {
  const i = process.argv.indexOf("--run-prefix");
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env.OPT_ARMS_RUN_PREFIX || "v2";
})();

const ARMS = [
  {
    track: "swe",
    session: "opt-swe-baseline",
    runId: "hri-swe-opt-arms-v1-baseline",
    manifest: "case-studies/swe-bench/manifest-optimize.yml",
    condition: "counterbalanced",
    extra: [],
  },
  {
    track: "swe",
    session: "opt-swe-budget",
    runId: "hri-swe-opt-arms-v1-budget",
    manifest: "case-studies/swe-bench/manifest-optimize.yml",
    condition: "cb-budget",
    extra: ["--soft-retry-plan"],
  },
  {
    track: "swe",
    session: "opt-swe-mutable",
    runId: "hri-swe-opt-arms-v1-mutable",
    manifest: "case-studies/swe-bench/manifest-optimize.yml",
    condition: "cb-mutable",
    extra: ["--max-task-tries", "5"],
  },
  {
    track: "swe",
    session: "opt-swe-optimize",
    runId: "hri-swe-opt-arms-v1-optimize",
    manifest: "case-studies/swe-bench/manifest-optimize.yml",
    condition: "cb-optimize",
    extra: ["--max-task-tries", "5", "--optimize-on-fail"],
  },
  {
    track: "tau",
    session: "opt-tau-baseline",
    runId: "hri-tau-opt-arms-v1-baseline",
    manifest: "case-studies/tau-bench/manifest-optimize.yml",
    condition: "counterbalanced",
    extra: [],
  },
  {
    track: "tau",
    session: "opt-tau-budget",
    runId: "hri-tau-opt-arms-v1-budget",
    manifest: "case-studies/tau-bench/manifest-optimize.yml",
    condition: "cb-budget",
    extra: [],
  },
  {
    track: "tau",
    session: "opt-tau-mutable",
    runId: "hri-tau-opt-arms-v1-mutable",
    manifest: "case-studies/tau-bench/manifest-optimize.yml",
    condition: "cb-mutable",
    extra: ["--max-task-tries", "5"],
  },
  {
    track: "tau",
    session: "opt-tau-optimize",
    runId: "hri-tau-opt-arms-v1-optimize",
    manifest: "case-studies/tau-bench/manifest-optimize.yml",
    condition: "cb-optimize",
    extra: ["--max-task-tries", "5", "--optimize-on-fail"],
  },
];

for (const arm of ARMS) {
  arm.runId = arm.runId.replace("opt-arms-v1-", `opt-arms-${RUN_PREFIX}-`);
}

function parseArgs(argv) {
  const cmd = argv[0] ?? "help";
  let dryRun = false;
  let track = null;
  let arm = null;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--dry-run") dryRun = true;
    else if (argv[i] === "--track" && argv[i + 1]) {
      track = argv[++i];
    } else if (argv[i] === "--arm" && argv[i + 1]) {
      arm = argv[++i];
    }
  }
  return { cmd, dryRun, track, arm };
}

function selectArms({ track, arm }) {
  let arms = track ? ARMS.filter((a) => a.track === track) : ARMS;
  if (arm) {
    arms = arms.filter((a) => a.session === `opt-swe-${arm}` || a.session === `opt-tau-${arm}`);
  }
  return arms;
}

function tmuxExists(session) {
  const r = spawnSync("tmux", ["has-session", "-t", session], { encoding: "utf8" });
  return r.status === 0;
}

function shellActivate() {
  return [
    `cd ${JSON.stringify(root)}`,
    `export NVM_DIR="$HOME/.nvm"`,
    `[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"`,
    `nvm use >/dev/null 2>&1 || true`,
    `export PATH="$NVM_DIR/versions/node/$(nvm version 2>/dev/null)/bin:$PATH"`,
    `[ -f .venv/bin/activate ] && . .venv/bin/activate`,
    `set -a; [ -f .env ] && . ./.env; set +a`,
  ].join(" && ");
}

function buildCommand(arm) {
  const logDir = join(root, "live/reports/kit-probe");
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `${arm.runId}.log`);
  const nodeCmd = [
    "node scripts/case-study-coding.mjs",
    "--mode live",
    `--manifest ${arm.manifest}`,
    `--conditions ${arm.condition}`,
    "--kit-models kit.gemma4-31b-it",
    "--reps 1",
    `--run-id ${arm.runId}`,
    "--resume",
    "--skip-conformance",
    ...arm.extra,
  ].join(" ");
  return `${shellActivate()} && set -o pipefail && (${nodeCmd}) 2>&1 | tee ${JSON.stringify(logFile)}; echo EXIT:$? | tee -a ${JSON.stringify(logFile)}`;
}

function launch({ dryRun, track, arm }) {
  const arms = selectArms({ track, arm });
  const shardMap = arms.map((arm) => ({
    session: arm.session,
    run_id: arm.runId,
    condition: arm.condition,
    manifest: arm.manifest,
  }));
  const mapPath = join(root, "live/reports/kit-probe/opt-arms-shards.json");
  mkdirSync(dirname(mapPath), { recursive: true });
  writeFileSync(mapPath, JSON.stringify({ created_at: new Date().toISOString(), shards: shardMap }, null, 2) + "\n");

  for (const arm of arms) {
    const full = buildCommand(arm);
    if (dryRun) {
      console.log(`[dry-run] tmux new-session -d -s ${arm.session}`);
      console.log(`  ${full.slice(0, 200)}...`);
      continue;
    }
    if (tmuxExists(arm.session)) {
      console.error(`[skip] session exists: ${arm.session}`);
      continue;
    }
    execFileSync("tmux", ["new-session", "-d", "-s", arm.session, "bash", "-lc", full], {
      stdio: "inherit",
    });
    console.error(`[launched] ${arm.session} → ${arm.runId}`);
  }
  console.error(`[opt-arms] ${dryRun ? "dry-run" : "launched"} ${arms.length} sessions (parallel)`);
}

function status({ track, arm } = {}) {
  const arms = selectArms({ track, arm });
  for (const arm of arms) {
    const alive = tmuxExists(arm.session);
    const rawGuess = join(
      root,
      "live/reports/case-studies",
      arm.track === "swe" ? "swe-bench" : "tau-bench",
      arm.runId,
      "ledger.json",
    );
    let scored = "no-ledger";
    if (existsSync(rawGuess)) {
      try {
        const ledger = JSON.parse(readFileSync(rawGuess, "utf8"));
        scored = String((ledger.attempts ?? []).filter((a) => a.status === "scored").length);
      } catch {
        scored = "err";
      }
    }
    console.log(
      `${arm.session}\talive=${alive}\trun=${arm.runId}\tscored=${scored}`,
    );
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.cmd === "launch") launch(args);
  else if (args.cmd === "status") status(args);
  else {
    console.log(`Usage:
  node scripts/opt-arms-tmux.mjs launch [--dry-run] [--run-prefix v2] [--track swe|tau] [--arm baseline|budget|mutable|optimize]
  node scripts/opt-arms-tmux.mjs status [--track swe|tau] [--arm NAME]`);
    process.exit(args.cmd === "help" ? 0 : 1);
  }
}

main();
