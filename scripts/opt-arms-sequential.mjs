#!/usr/bin/env node
/**
 * Run SWE opt-arms one session at a time (avoids KIT fetch failures).
 * Usage: OPT_ARMS_RUN_PREFIX=v3 node scripts/opt-arms-sequential.mjs launch
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const prefix = process.env.OPT_ARMS_RUN_PREFIX || "v3";
const arms = ["baseline", "budget", "mutable", "optimize"];

const script = [
  `cd ${JSON.stringify(root)}`,
  `export NVM_DIR="$HOME/.nvm"`,
  `[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"`,
  `nvm use >/dev/null 2>&1 || true`,
  `[ -f .venv/bin/activate ] && . .venv/bin/activate`,
  `set -a; [ -f .env ] && . ./.env; set +a`,
  `export OPT_ARMS_RUN_PREFIX=${prefix}`,
  ...arms.flatMap((arm) => [
    `echo "[seq] launching opt-swe-${arm}"`,
    `node scripts/opt-arms-tmux.mjs launch --run-prefix ${prefix} --track swe --arm ${arm}`,
    `while tmux has-session -t opt-swe-${arm} 2>/dev/null; do sleep 120; done`,
    `echo "[seq] finished opt-swe-${arm}"`,
  ]),
  `node scripts/compare-opt-arms-s.mjs | tee live/reports/kit-probe/opt-arms-v3-comparison.txt`,
].join(" && ");

if (process.argv[2] === "launch") {
  execFileSync("tmux", ["new-session", "-d", "-s", "opt-swe-seq", "bash", "-lc", script], {
    stdio: "inherit",
  });
  console.error("[opt-swe-seq] sequential SWE launcher started");
} else {
  console.log("Usage: OPT_ARMS_RUN_PREFIX=v3 node scripts/opt-arms-sequential.mjs launch");
}
