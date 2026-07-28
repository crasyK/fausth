#!/usr/bin/env node
/**
 * Prove TS resolve ≡ Python resolve for connector harnesses (byte-identical).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const harnesses = [
  join(root, "examples/primitives/inline-file-connectors"),
  join(root, "examples/coding-counterbalance"),
];
const tmp = mkdtempSync(join(tmpdir(), "fausth-resolve-"));

function resolveTs(harness, out) {
  execFileSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "resolve", harness, "--out", out],
    { cwd: join(root, "engines/ts"), stdio: "pipe", windowsHide: true },
  );
}

function resolvePy(harness, out) {
  execFileSync("python", ["-m", "fausth", "resolve", harness, "--out", out], {
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
  for (const harness of harnesses) {
    const name = harness.split(/[/\\]/).pop();
    const tsOut = join(tmp, `${name}.ts.json`);
    const pyOut = join(tmp, `${name}.py.json`);
    resolveTs(harness, tsOut);
    resolvePy(harness, pyOut);
    const tsBytes = readFileSync(tsOut);
    const pyBytes = readFileSync(pyOut);
    if (!tsBytes.equals(pyBytes)) {
      writeFileSync(join(tmp, `${name}.ts.txt`), tsBytes);
      writeFileSync(join(tmp, `${name}.py.txt`), pyBytes);
      console.error(`TS and Python resolve differ for ${name}`);
      console.error(`TS bytes=${tsBytes.length} Py bytes=${pyBytes.length}`);
      const n = Math.min(tsBytes.length, pyBytes.length);
      for (let i = 0; i < n; i++) {
        if (tsBytes[i] !== pyBytes[i]) {
          console.error(`first diff at byte ${i}`);
          console.error(`TS: ${tsBytes.subarray(Math.max(0, i - 40), i + 40).toString("utf8")}`);
          console.error(`Py: ${pyBytes.subarray(Math.max(0, i - 40), i + 40).toString("utf8")}`);
          break;
        }
      }
      console.error(`diff artifacts kept in ${tmp}`);
      process.exit(1);
    }
    console.log(`OK byte-identical resolve (${name}, ${tsBytes.length} bytes)`);
  }
  rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  console.error(e);
  process.exit(1);
}
