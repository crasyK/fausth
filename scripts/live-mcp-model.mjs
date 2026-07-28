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
 * Skips (exit 0) when the required API key is missing.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const harness = join(root, "examples/primitives/mcp-connectors");
const reportDir = join(root, "live/reports");
mkdirSync(reportDir, { recursive: true });

function loadDotEnv(path = join(root, ".env")) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv();

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
        deployment: join(harness, "deployment.stdio-kit.yml"),
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
  const msg = String(err.stderr || err.stdout || err.message || err);
  if (/rate.?limit|429|empty catalog|no models/i.test(msg)) {
    console.log(JSON.stringify({ skipped: true, reason: "rate_limited_or_catalog", provider: cfg.name }));
    process.exit(0);
  }
  console.error(msg);
  process.exit(1);
}

const events = readFileSync(dump, "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const execute = events.find(
  (e) =>
    e.tool === "get_forecast" &&
    e.stage === "execute" &&
    e.verdict === "allow" &&
    e.result &&
    typeof e.result.summary === "string" &&
    typeof e.result.temp_c === "number",
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
