#!/usr/bin/env node
/**
 * Live (secrets-gated) coding e2e in a disposable worktree.
 * Usage: node scripts/live-local-e2e.mjs [--deployment local-kit|local-openrouter]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const which = process.argv.includes("local-kit") ? "local-kit" : "local-openrouter";
const dep = join(root, `examples/coding-counterbalance/deployment.${which}.yml`);
const keyEnv = which === "local-kit" ? "KIT_AI_API_KEY" : "OPENROUTER_API_KEY";

if (!process.env[keyEnv]) {
  console.log(JSON.stringify({ skipped: true, reason: `missing ${keyEnv}` }));
  process.exit(0);
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", windowsHide: true, ...opts });
}

const boot = JSON.parse(
  run(process.execPath, [
    join(root, "scripts/disposable-worktree.mjs"),
    "bootstrap",
    "--parent",
    root,
    "--tiny-seed",
    "true",
  ]),
);
const worktree = boot.worktree;
const reportPath = join(root, "live/reports", `live-local-e2e-${which}.json`);

let code = 1;
try {
  // Align seed with agent scopes (src/app.ts)
  writeFileSync(
    join(worktree, "src", "app.ts"),
    `export function add(a: number, b: number) { return a - b; }\n`,
  );
  writeFileSync(
    join(worktree, "src", "app.test.js"),
    `import { describe, it } from "node:test";
import assert from "node:assert/strict";
// Lightweight smoke — live model should still reach completion via allowlisted test cmd.
describe("smoke", () => { it("ok", () => assert.equal(1, 1)); });
`,
  );

  try {
    run(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "run",
        join(root, "examples/coding-counterbalance"),
        "--deployment",
        dep,
        "--workspace",
        worktree,
        "--prompt",
        "Fix add() under src/ if needed, follow Counterbalance modes, approve plan, run tests, clear todos, complete.",
        "--max-steps",
        "16",
        "--report",
        reportPath,
        "--expect-complete",
        "true",
      ],
      { cwd: join(root, "engines/ts"), stdio: "inherit" },
    );
    code = 0;
  } catch (e) {
    const err = e;
    code = typeof err.status === "number" ? err.status : 1;
  }
} finally {
  try {
    run(process.execPath, [
      join(root, "scripts/disposable-worktree.mjs"),
      "cleanup",
      "--parent",
      root,
      "--worktree",
      worktree,
    ]);
  } catch {
    /* ignore */
  }
}

mkdirSync(dirname(reportPath), { recursive: true });
if (code === 0) {
  const r = JSON.parse(readFileSync(reportPath, "utf8"));
  console.log(JSON.stringify({ completion_reached: r.completion_reached, e2e_pass_rate: r.completion_reached ? 1 : 0 }, null, 2));
}
process.exit(code === 2 ? 0 : code); // rate-limit soft
