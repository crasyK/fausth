#!/usr/bin/env node
/**
 * Live model + live MCP stdio smoke.
 * Spawns the toy weather MCP server AND calls a real chat model (KIT or OpenRouter).
 *
 * Usage:
 *   node scripts/live-mcp-model.mjs              # prefer KIT, else OpenRouter
 *   node scripts/live-mcp-model.mjs kit
 *   node scripts/live-mcp-model.mjs openrouter
 *
 * Skips (exit 0) when the required API key is missing; exit 2 = infrastructure failure.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { successfulCalls } from "./case-study-pipeline.mjs";
import { loadDotEnv } from "./lib/env.mjs";
import { classifyFailure } from "./lib/failure.mjs";
import { DEFAULT_KIT_MODEL } from "./lib/kit-models.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const harness = join(root, "examples/primitives/mcp-connectors");
const reportDir = join(root, "live/reports");
mkdirSync(reportDir, { recursive: true });
const YAML = createRequire(join(root, "engines/ts/package.json"))("yaml");

loadDotEnv(join(root, ".env"));

/** KIT runs use the D15 model regardless of the example's pinned list. */
function kitDeployment() {
  const dep = YAML.parse(readFileSync(join(harness, "deployment.stdio-kit.yml"), "utf8"));
  dep.model = { ...(dep.model ?? {}), models: [DEFAULT_KIT_MODEL] };
  const out = join(reportDir, "live-mcp-model-kit.deployment.yml");
  writeFileSync(out, YAML.stringify(dep));
  return out;
}

const whichArg = process.argv[2];
const prefer =
  whichArg === "kit" || whichArg === "openrouter"
    ? whichArg
    : process.env.KIT_AI_API_KEY
      ? "kit"
      : "openrouter";

const cfg =
  prefer === "kit"
    ? {
        name: "kit",
        keyEnv: "KIT_AI_API_KEY",
        deployment: null,
      }
    : {
        name: "openrouter",
        keyEnv: "OPENROUTER_API_KEY",
        deployment: join(harness, "deployment.stdio-openrouter.yml"),
      };

if (!process.env[cfg.keyEnv]) {
  console.log(JSON.stringify({ skipped: true, reason: `missing ${cfg.keyEnv}` }));
  process.exit(0);
}
if (cfg.name === "kit") cfg.deployment = kitDeployment();

const dump = join(reportDir, `live-mcp-model-${cfg.name}.jsonl`);
const prompt =
  "Call the get_forecast tool exactly once with city set to Berlin. After you receive the tool result, stop. Do not call sensor.fan.read_percent.";

let stdout = "";
try {
  stdout = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/cli.ts",
      "run",
      harness,
      "--deployment",
      cfg.deployment,
      "--prompt",
      prompt,
      "--max-steps",
      "8",
      "--dump",
      dump,
      "--report",
      join(reportDir, `live-mcp-model-${cfg.name}.json`),
    ],
    {
      cwd: join(root, "engines/ts"),
      encoding: "utf8",
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
} catch (e) {
  const err = e;
  const failure = classifyFailure({ message: String(err.message ?? ""), stderr: String(err.stderr ?? "") });
  if (failure.infra) {
    // Exit 2: infrastructure (rate limit / auth / gateway / network) — reported, not a pass.
    console.log(JSON.stringify({ infra_failure: failure, provider: cfg.name }));
    process.exit(2);
  }
  console.error(String(err.stderr || err.stdout || err.message || err));
  process.exit(1);
}

const eventsText = readFileSync(dump, "utf8");
const events = eventsText
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l));

// D8: the MCP call counts only when it was executed AND verified.
const execute = successfulCalls(eventsText).find(
  (c) =>
    c.tool === "get_forecast" &&
    c.result &&
    typeof c.result.summary === "string" &&
    typeof c.result.temp_c === "number",
);

if (!execute) {
  console.error("FAIL: no successful get_forecast execute from live model + MCP");
  console.error(`dump: ${dump}`);
  console.error(stdout.slice(-2000));
  process.exit(1);
}

const summary = {
  ok: true,
  provider: cfg.name,
  model_used: (() => {
    try {
      return JSON.parse(readFileSync(join(reportDir, `live-mcp-model-${cfg.name}.json`), "utf8"))
        .model;
    } catch {
      return null;
    }
  })(),
  city: execute.args?.city ?? null,
  mcp_result: execute.result,
  events: events.length,
  dump,
};
writeFileSync(
  join(reportDir, `live-mcp-model-${cfg.name}-summary.json`),
  JSON.stringify(summary, null, 2) + "\n",
);
console.log(
  `OK live model (${cfg.name}) + MCP stdio → get_forecast ${JSON.stringify(execute.result)}`,
);
