#!/usr/bin/env node
/**
 * Bootstrap / cleanup an isolated disposable workspace for local agent runs.
 *
 * The workspace is a linked worktree of a PRIVATE repository that contains only
 * the seed — never a checkout of the Fausth repository (see scripts/lib/workspace.mjs).
 *
 * Usage:
 *   node scripts/disposable-worktree.mjs bootstrap [--seed <dir> | --tiny-seed true | --tiny-seed false | --empty true] [--root <dir>]
 *   node scripts/disposable-worktree.mjs cleanup --worktree <path> [--root <dir>]
 *
 * `--parent` is accepted for backwards compatibility and ignored.
 * The workspace root defaults to $FAUSTH_WORKSPACE_ROOT or <tmpdir>/fausth-workspaces.
 */
import { pathToFileURL } from "node:url";
import { bootstrapWorkspace, cleanupWorkspace } from "./lib/workspace.mjs";

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = "true";
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

/** @param {Record<string, string>} args */
export function cmdBootstrap(args) {
  const seed = args.seed && args.seed !== "true" ? args.seed : null;
  const empty = args.empty === "true" || args["tiny-seed"] === "false";
  const tinySeed = !seed && !empty;
  return bootstrapWorkspace({ seed, tinySeed, root: args.root });
}

/** @param {Record<string, string>} args */
export function cmdCleanup(args) {
  if (!args.worktree || args.worktree === "true") {
    throw new Error("cleanup requires --worktree <path>");
  }
  return cleanupWorkspace({ worktree: args.worktree, root: args.root });
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  try {
    if (cmd === "bootstrap") console.log(JSON.stringify(cmdBootstrap(args)));
    else if (cmd === "cleanup") console.log(JSON.stringify(cmdCleanup(args)));
    else {
      console.error("Usage: disposable-worktree.mjs bootstrap|cleanup ...");
      process.exit(1);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
