#!/usr/bin/env node
/**
 * Bootstrap / cleanup a linked disposable git worktree for local coding runs.
 *
 * Usage:
 *   node scripts/disposable-worktree.mjs bootstrap [--parent <repo>] [--out <path>] [--seed <dir>]
 *   node scripts/disposable-worktree.mjs cleanup --parent <repo> --worktree <path>
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = "true";
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

function seedTinyRepo(dir) {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "app.js"),
    `export function add(a, b) {
  return a - b; // intentionally wrong — agent should fix to a + b
}
`,
  );
  writeFileSync(
    join(dir, "src", "app.test.js"),
    `import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { add } from "./app.js";

describe("add", () => {
  it("adds", () => {
    assert.equal(add(2, 3), 5);
  });
});
`,
  );
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module", name: "fausth-e2e-seed" }, null, 2) + "\n");
  writeFileSync(join(dir, "README.md"), "Disposable Fausth e2e workspace\n");
}

function cmdBootstrap(args) {
  const parent = resolve(args.parent ?? root);
  const out =
    args.out ??
    mkdtempSync(join(tmpdir(), "fausth-disposable-"));
  if (existsSync(out) && git(parent, ["worktree", "list"]).includes(out.replace(/\\/g, "/"))) {
    throw new Error(`worktree already exists: ${out}`);
  }
  // Ensure parent is a git repo
  git(parent, ["rev-parse", "--is-inside-work-tree"]);
  // Detached linked worktree — no long-lived branch litter
  git(parent, ["worktree", "add", "--detach", out, "HEAD"]);

  if (args.seed) {
    const seed = resolve(args.seed);
    cpSync(seed, out, { recursive: true, force: true });
  } else if (args["tiny-seed"] === "true") {
    seedTinyRepo(out);
  } else if (args["empty"] === "true" || args["tiny-seed"] === "false") {
    // Leave worktree empty (aside from .git) for git_checkout / external seeders.
  } else {
    seedTinyRepo(out);
  }

  const meta = {
    parent,
    worktree: out,
    branch: null,
    created_at: new Date().toISOString(),
  };
  writeFileSync(join(out, ".fausth-worktree.json"), JSON.stringify(meta, null, 2) + "\n");
  console.log(JSON.stringify(meta));
  return meta;
}

function cmdCleanup(args) {
  const parent = resolve(args.parent ?? root);
  const worktree = resolve(args.worktree ?? "");
  if (!worktree) throw new Error("--worktree required");
  try {
    git(parent, ["worktree", "remove", "--force", worktree]);
  } catch {
    rmSync(worktree, { recursive: true, force: true });
    try {
      git(parent, ["worktree", "prune"]);
    } catch {
      /* ignore */
    }
  }
  // delete branch if present in meta
  const metaPath = join(worktree, ".fausth-worktree.json");
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      if (meta.branch) git(parent, ["branch", "-D", meta.branch]);
    } catch {
      /* ignore */
    }
  }
  console.log(JSON.stringify({ cleaned: worktree }));
}

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
try {
  if (cmd === "bootstrap") cmdBootstrap(args);
  else if (cmd === "cleanup") cmdCleanup(args);
  else {
    console.error("Usage: disposable-worktree.mjs bootstrap|cleanup ...");
    process.exit(1);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
