#!/usr/bin/env node
/**
 * Prove connector-provided tools execute identically in TS and Python
 * for both directory harnesses and packed v0.2 bundles.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const harness = join(root, "examples/primitives/inline-file-connectors");
const expected = readFileSync(join(harness, "smoke.expected.jsonl"));
const tmp = mkdtempSync(join(tmpdir(), "fausth-connector-exec-"));

function runTs(target, dump, deployment, model) {
  const args = [
    "--import",
    "tsx",
    "src/cli.ts",
    "run",
    target,
    "--deployment",
    deployment,
    "--model",
    model,
    "--dump",
    dump,
  ];
  execFileSync(process.execPath, args, {
    cwd: join(root, "engines/ts"),
    stdio: "pipe",
    windowsHide: true,
  });
}

function runPy(target, dump, deployment, model) {
  execFileSync(
    "python",
    ["-m", "fausth", "run", target, "--deployment", deployment, "--model", model, "--dump", dump],
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
}

function assertParity(label, tsBytes, pyBytes) {
  if (!tsBytes.equals(pyBytes)) {
    throw new Error(
      `${label}: connector execution parity failed: TS=${tsBytes.length} bytes, Python=${pyBytes.length} bytes`,
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
  const deployment = join(harness, "deployment.fixture.yml");
  const model = join(harness, "smoke.model.jsonl");

  const tsDirOut = join(tmp, "ts.dir.events.jsonl");
  const pyDirOut = join(tmp, "py.dir.events.jsonl");
  runTs(harness, tsDirOut, deployment, model);
  runPy(harness, pyDirOut, deployment, model);
  assertParity("directory", readFileSync(tsDirOut), readFileSync(pyDirOut));

  const bundleOut = join(tmp, "inline-file-connectors.fausth.json");
  execFileSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "pack", harness, "--out", bundleOut],
    { cwd: join(root, "engines/ts"), stdio: "pipe", windowsHide: true },
  );
  const parsed = JSON.parse(readFileSync(bundleOut, "utf8"));
  if (parsed.format !== "fausth-harness-bundle/v0.2") {
    throw new Error(`expected v0.2 bundle, got ${parsed.format}`);
  }

  // Bundle run uses auto-discovered deployment/model inside the unpacked harness.
  const tsBundleOut = join(tmp, "ts.bundle.events.jsonl");
  const pyBundleOut = join(tmp, "py.bundle.events.jsonl");
  execFileSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "run", bundleOut, "--dump", tsBundleOut],
    { cwd: join(root, "engines/ts"), stdio: "pipe", windowsHide: true },
  );
  execFileSync(
    "python",
    ["-m", "fausth", "run", bundleOut, "--dump", pyBundleOut],
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
  assertParity("v0.2 bundle", readFileSync(tsBundleOut), readFileSync(pyBundleOut));

  rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  console.error(e);
  console.error(`artifacts kept in ${tmp}`);
  process.exit(1);
}
