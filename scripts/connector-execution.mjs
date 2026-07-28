#!/usr/bin/env node
/**
 * Prove connector-provided tools execute identically in TS and Python.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const harness = join(root, "examples/primitives/inline-file-connectors");
const deployment = join(harness, "deployment.fixture.yml");
const model = join(harness, "smoke.model.jsonl");
const expected = readFileSync(join(harness, "smoke.expected.jsonl"));
const tmp = mkdtempSync(join(tmpdir(), "fausth-connector-exec-"));

try {
  const tsOut = join(tmp, "ts.events.jsonl");
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
      "--model",
      model,
      "--dump",
      tsOut,
    ],
    { cwd: join(root, "engines/ts"), stdio: "pipe", windowsHide: true },
  );

  const pyOut = join(tmp, "py.events.jsonl");
  execFileSync(
    "python",
    [
      "-m",
      "fausth",
      "run",
      harness,
      "--deployment",
      deployment,
      "--model",
      model,
      "--dump",
      pyOut,
    ],
    {
      cwd: join(root, "engines/py"),
      env: {
        ...process.env,
        PYTHONPATH: join(root, "engines/py"),
        PYTHONIOENCODING: "utf-8",
      },
      stdio: "pipe",
      windowsHide: true,
    },
  );

  const tsBytes = readFileSync(tsOut);
  const pyBytes = readFileSync(pyOut);
  if (!tsBytes.equals(pyBytes)) {
    throw new Error(
      `connector execution parity failed: TS=${tsBytes.length} bytes, Python=${pyBytes.length} bytes`,
    );
  }
  if (!tsBytes.equals(expected)) {
    throw new Error(
      `connector execution differs from smoke.expected.jsonl (${tsBytes.length} vs ${expected.length} bytes)`,
    );
  }
  console.log(`OK connector execution TS ↔ Python ↔ expected (${tsBytes.length} bytes)`);
  rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  console.error(e);
  console.error(`artifacts kept in ${tmp}`);
  process.exit(1);
}
