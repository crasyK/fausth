#!/usr/bin/env node
/**
 * Run SWE opt-arms one session at a time (avoids KIT fetch failures), then print
 * the pass@1 comparison (scripts/compare-opt-arms-s.mjs).
 *
 * Usage: OPT_ARMS_RUN_PREFIX=v3 [OPT_ARMS_KIT_MODEL=kit.glm-5.3-flash] node scripts/opt-arms-sequential.mjs launch
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { repoActivation, shellQuote } from "./lib/shell.mjs";
import { validateRunPrefix } from "./opt-arms-tmux.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ARMS = ["baseline", "budget", "mutable", "optimize"];

/**
 * Bash script for the sequential chain. All interpolated values are quoted (SCR-17).
 * @param {string} prefix run-id version tag (validated)
 * @param {{ activate?: string, arms?: string[] }} [opts]
 */
export function sequentialScript(prefix, opts = {}) {
  const p = validateRunPrefix(prefix);
  const arms = opts.arms ?? ARMS;
  const activate = opts.activate ?? repoActivation(root, { mkdirs: ["live/reports/kit-probe"] });
  const steps = arms.map((arm) =>
    [
      `echo ${shellQuote(`[seq] launching opt-swe-${arm}`)}`,
      `node scripts/opt-arms-tmux.mjs launch --run-prefix ${shellQuote(p)} --track swe --arm ${shellQuote(arm)}`,
      `while tmux has-session -t ${shellQuote(`opt-swe-${arm}`)} 2>/dev/null; do sleep 120; done`,
      `echo ${shellQuote(`[seq] finished opt-swe-${arm}`)}`,
    ].join(" && "),
  );
  const report = shellQuote(`live/reports/kit-probe/opt-arms-${p}-comparison.txt`);
  return [
    "set -o pipefail",
    activate,
    `export OPT_ARMS_RUN_PREFIX=${shellQuote(p)}`,
    `${steps.join(" && ")} && node scripts/compare-opt-arms-s.mjs --prefixes ${shellQuote(`v2,${p}`)} | tee ${report}`,
  ].join("; ");
}

function main() {
  if (process.argv[2] !== "launch") {
    console.log("Usage: OPT_ARMS_RUN_PREFIX=v3 node scripts/opt-arms-sequential.mjs launch");
    return;
  }
  const script = sequentialScript(process.env.OPT_ARMS_RUN_PREFIX || "v3");
  execFileSync("tmux", ["new-session", "-d", "-s", "opt-swe-seq", "bash", "-lc", script], {
    stdio: "inherit",
  });
  console.error("[opt-swe-seq] sequential SWE launcher started");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
