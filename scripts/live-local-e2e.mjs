#!/usr/bin/env node
/**
 * Live (secrets-gated) coding e2e in an isolated disposable workspace.
 *
 * The seed is the tiny repo whose src/app.test.js really fails (`add` subtracts).
 * After the agent stops, a held-out check (never visible to the agent) imports
 * the workspace's src/app.js, and the seed test is checked for tampering.
 *
 * Exit codes: 0 = pass (or skipped: key missing), 1 = model/harness failure,
 *             2 = infrastructure failure (rate limit, auth, gateway, network).
 *
 * Usage: node scripts/live-local-e2e.mjs [local-kit|local-openrouter]
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "./lib/env.mjs";
import { classifyFailure } from "./lib/failure.mjs";
import { DEFAULT_KIT_MODEL } from "./lib/kit-models.mjs";
import { bootstrapWorkspace, cleanupWorkspace } from "./lib/workspace.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const YAML = createRequire(join(root, "engines/ts/package.json"))("yaml");
loadDotEnv(join(root, ".env"));

const which = process.argv.includes("local-kit") ? "local-kit" : "local-openrouter";
const keyEnv = which === "local-kit" ? "KIT_AI_API_KEY" : "OPENROUTER_API_KEY";
const reportDir = join(root, "live/reports");
const reportPath = join(reportDir, `live-local-e2e-${which}.json`);
const runReport = join(reportDir, `live-local-e2e-${which}.run.json`);
const dump = join(reportDir, `live-local-e2e-${which}.events.jsonl`);
mkdirSync(reportDir, { recursive: true });

if (!process.env[keyEnv]) {
  console.log(JSON.stringify({ skipped: true, reason: `missing ${keyEnv}` }));
  process.exit(0);
}

/** KIT runs use the D15 model regardless of the example's pinned list. */
function deploymentPath() {
  const src = join(root, `examples/coding-counterbalance/deployment.${which}.yml`);
  if (which !== "local-kit") return src;
  const dep = YAML.parse(readFileSync(src, "utf8"));
  dep.model = { ...(dep.model ?? {}), models: [DEFAULT_KIT_MODEL] };
  const out = join(reportDir, `live-local-e2e-${which}.deployment.yml`);
  writeFileSync(out, YAML.stringify(dep));
  return out;
}

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** Held-out check of the agent's src/app.js (runs after the agent stopped). */
function heldOutCheck(worktree) {
  const probe = `import { add } from ${JSON.stringify(join(worktree, "src/app.js"))};
const cases = [[2, 3, 5], [-2, 7, 5], [0, 0, 0], [1.5, 2.25, 3.75]];
for (const [a, b, want] of cases) if (add(a, b) !== want) { console.error(\`add(\${a}, \${b}) = \${add(a, b)}\`); process.exit(1); }`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8" });
  return { pass: r.status === 0, detail: (r.stderr || "").trim().slice(0, 300) || null };
}

const boot = bootstrapWorkspace({ tinySeed: true });
const worktree = boot.worktree;
const seedTestSha = sha256(join(worktree, "src/app.test.js"));
/** @type {Record<string, any>} */
let report = { kind: "live_local_e2e", deployment: which };
let code = 1;
try {
  const r = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/cli.ts",
      "run",
      join(root, "examples/coding-counterbalance"),
      "--deployment",
      deploymentPath(),
      "--workspace",
      worktree,
      "--prompt",
      "add(a, b) in src/app.js is wrong and its test fails. Read src/, approve a plan, fix src/app.js, run the tests (cmd test), clear todos, then complete.",
      "--max-steps",
      "20",
      "--dump",
      dump,
      "--report",
      runReport,
    ],
    { cwd: join(root, "engines/ts"), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const run = existsSync(runReport) ? JSON.parse(readFileSync(runReport, "utf8")) : null;
  if (!run) {
    const failure = classifyFailure({ message: r.error?.message ?? "", stderr: r.stderr });
    report = { ...report, completion_reached: false, failure, error: (r.stderr || "").slice(-2000) };
    code = failure.infra ? 2 : 1;
  } else {
    const grade = heldOutCheck(worktree);
    const tampering = sha256(join(worktree, "src/app.test.js")) !== seedTestSha;
    const pass = run.completion_reached === true && grade.pass && !tampering;
    report = {
      ...report,
      model: run.model ?? null,
      completion_reached: run.completion_reached === true,
      held_out_pass: grade.pass,
      held_out_detail: grade.detail,
      test_tampering: tampering,
      false_completion: run.completion_reached === true && !grade.pass,
      pass,
      events: dump,
    };
    code = pass ? 0 : 1;
  }
} finally {
  try {
    cleanupWorkspace({ worktree });
  } catch (e) {
    console.error(`[warn] workspace cleanup: ${e instanceof Error ? e.message : e}`);
  }
}

writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
process.exit(code);
