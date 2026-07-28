#!/usr/bin/env node
/**
 * Prove MCP recorded connectors execute identically in TS and Python
 * for directory harnesses and packed v0.3 bundles.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const harness = join(root, "examples/primitives/mcp-connectors");
const expected = readFileSync(join(harness, "smoke.expected.jsonl"));
const tmp = mkdtempSync(join(tmpdir(), "fausth-mcp-exec-"));

function runTs(target, dump) {
  execFileSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "run", target, "--dump", dump],
    { cwd: join(root, "engines/ts"), stdio: "pipe", windowsHide: true },
  );
}

function runPy(target, dump) {
  execFileSync("python", ["-m", "fausth", "run", target, "--dump", dump], {
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

function assertParity(label, tsBytes, pyBytes) {
  if (!tsBytes.equals(pyBytes)) {
    throw new Error(
      `${label}: MCP execution parity failed: TS=${tsBytes.length} bytes, Python=${pyBytes.length} bytes`,
    );
  }
  if (!tsBytes.equals(expected)) {
    throw new Error(
      `${label}: differs from smoke.expected.jsonl (${tsBytes.length} vs ${expected.length} bytes)`,
    );
  }
  console.log(`OK ${label} TS ↔ Python ↔ expected (${tsBytes.length} bytes)`);
}

try {
  const tsDir = join(tmp, "ts.dir.jsonl");
  const pyDir = join(tmp, "py.dir.jsonl");
  runTs(harness, tsDir);
  runPy(harness, pyDir);
  assertParity("directory", readFileSync(tsDir), readFileSync(pyDir));

  const bundleOut = join(tmp, "mcp-connectors.fausth.json");
  execFileSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "pack", harness, "--out", bundleOut],
    { cwd: join(root, "engines/ts"), stdio: "pipe", windowsHide: true },
  );
  const parsed = JSON.parse(readFileSync(bundleOut, "utf8"));
  if (parsed.format !== "fausth-harness-bundle/v0.3") {
    throw new Error(`expected v0.3 bundle, got ${parsed.format}`);
  }

  const tsBundle = join(tmp, "ts.bundle.jsonl");
  const pyBundle = join(tmp, "py.bundle.jsonl");
  runTs(bundleOut, tsBundle);
  runPy(bundleOut, pyBundle);
  assertParity("v0.3 bundle", readFileSync(tsBundle), readFileSync(pyBundle));

  rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  console.error(e);
  console.error(`artifacts kept in ${tmp}`);
  process.exit(1);
}
