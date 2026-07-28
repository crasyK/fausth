#!/usr/bin/env node
/**
 * Live MCP stdio smoke: spawn toy weather server via deployment.stdio.yml.
 * Proves TS and Python hosts call a real process over JSON-RPC (not recorded).
 *
 * Usage: node scripts/live-mcp-stdio.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const harness = join(root, "examples/primitives/mcp-connectors");
const deployment = join(harness, "deployment.stdio.yml");
const expected = readFileSync(join(harness, "smoke.expected.jsonl"));
const tmp = mkdtempSync(join(tmpdir(), "fausth-live-mcp-"));
const reportDir = join(root, "live/reports");
mkdirSync(reportDir, { recursive: true });

function runTs(dump) {
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/cli.ts",
      "run",
      harness,
      "--deployment",
      deployment,
      "--dump",
      dump,
    ],
    { cwd: join(root, "engines/ts"), stdio: "pipe", windowsHide: true },
  );
}

function runPy(dump) {
  execFileSync("python", ["-m", "fausth", "run", harness, "--deployment", deployment, "--dump", dump], {
    cwd: join(root, "engines/py"),
    env: {
      ...process.env,
      PYTHONPATH: join(root, "engines/py"),
      PYTHONIOENCODING: "utf-8",
    },
    stdio: "pipe",
    windowsHide: true,
  });
}

try {
  const tsDump = join(tmp, "ts.jsonl");
  const pyDump = join(tmp, "py.jsonl");
  runTs(tsDump);
  runPy(pyDump);

  const tsBytes = readFileSync(tsDump);
  const pyBytes = readFileSync(pyDump);
  if (!tsBytes.equals(pyBytes)) {
    throw new Error(`TS/Python dump mismatch: ${tsBytes.length} vs ${pyBytes.length}`);
  }
  if (!tsBytes.equals(expected)) {
    throw new Error(
      `live stdio dump differs from smoke.expected.jsonl (${tsBytes.length} vs ${expected.length})`,
    );
  }

  const report = {
    ok: true,
    transport: "stdio",
    bytes: tsBytes.length,
    deployment: "deployment.stdio.yml",
    server: "servers/weather-stdio.mjs",
  };
  writeFileSync(join(reportDir, "live-mcp-stdio.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`OK live MCP stdio TS ↔ Python ↔ expected (${tsBytes.length} bytes)`);
  rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  console.error(e);
  console.error(`artifacts kept in ${tmp}`);
  process.exit(1);
}
