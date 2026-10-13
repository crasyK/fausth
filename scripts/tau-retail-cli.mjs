#!/usr/bin/env node
/**
 * Thin wrapper around the canonical τ-bench retail world
 * (case-studies/tau-bench/world/tau.mjs) — kept for old command lines.
 * There is exactly one implementation; see that file for commands.
 *   node scripts/tau-retail-cli.mjs --cwd <workspace> hash
 */
import { main } from "../case-studies/tau-bench/world/tau.mjs";

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(e instanceof Error ? e.stack : e);
  process.exitCode = 1;
}
