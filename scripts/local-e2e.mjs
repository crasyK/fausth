#!/usr/bin/env node
/**
 * Local coding e2e — recorded happy path inside a disposable linked worktree.
 * PR CI safe (no live model). Real KIT/OpenRouter stays in nightly workflow.
 *
 * Exit 0 on completion_reached; writes live/reports/local-e2e.json
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const harness = join(root, "examples/coding-counterbalance");
const reportPath = join(root, "live/reports/local-e2e.json");

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    windowsHide: true,
    ...opts,
  });
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
let report;
try {
  // Use recorded happy-path proposals with local auto checkpoint bindings
  const model = join(root, "conformance/fixtures/cb-coding-happy-path/model.jsonl");
  const dump = join(root, "live/reports/local-e2e.events.jsonl");
  const runReport = join(root, "live/reports/local-e2e-run.json");

  // Seed src/app.ts as the fixture expects (happy path writes src/app.ts)
  writeFileSync(join(worktree, "src", "app.ts"), "export {}\n");

  run(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/cli.ts",
      "run",
      harness,
      "--deployment",
      join(harness, "deployment.local-fixture.yml"),
      "--workspace",
      worktree,
      "--model",
      model,
      "--max-steps",
      "16",
      "--dump",
      dump,
      "--report",
      runReport,
      "--expect-complete",
      "true",
    ],
    { cwd: join(root, "engines/ts"), stdio: "pipe" },
  );

  const runJson = JSON.parse(readFileSync(runReport, "utf8"));
  report = {
    kind: "local_e2e",
    recorded: true,
    completion_reached: runJson.completion_reached === true,
    e2e_pass_rate: runJson.completion_reached ? 1 : 0,
    final_state: runJson.final_state,
    test_exit_code: runJson.test_exit_code,
    workspace: worktree,
    events: dump,
  };
} catch (e) {
  report = {
    kind: "local_e2e",
    recorded: true,
    completion_reached: false,
    e2e_pass_rate: 0,
    error: e instanceof Error ? e.message : String(e),
    workspace: worktree,
  };
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
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ completion_reached: report.completion_reached, e2e_pass_rate: report.e2e_pass_rate }, null, 2));
process.exit(report.completion_reached ? 0 : 1);
