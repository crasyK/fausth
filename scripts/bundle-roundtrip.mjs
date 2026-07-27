#!/usr/bin/env node
/**
 * Prove TS pack ≡ Python pack for coding-counterbalance (byte-identical).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const harness = join(root, "examples/coding-counterbalance");
const tmp = mkdtempSync(join(tmpdir(), "fausth-roundtrip-"));

try {
  const tsOut = join(tmp, "ts.fausth.json");
  execFileSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "pack", harness, "--out", tsOut],
    { cwd: join(root, "engines/ts"), stdio: "pipe", windowsHide: true },
  );
  const tsBytes = readFileSync(tsOut);

  const pyOut = join(tmp, "py.fausth.json");
  execFileSync("python", ["-m", "fausth", "pack", harness, "--out", pyOut], {
    cwd: join(root, "engines/py"),
    env: {
      ...process.env,
      PYTHONPATH: join(root, "engines/py"),
      PYTHONIOENCODING: "utf-8",
    },
    stdio: "pipe",
    windowsHide: true,
  });
  const pyBytes = readFileSync(pyOut);

  if (!tsBytes.equals(pyBytes)) {
    writeFileSync(join(tmp, "ts.txt"), tsBytes);
    writeFileSync(join(tmp, "py.txt"), pyBytes);
    console.error("TS and Python packs differ");
    console.error(`TS bytes=${tsBytes.length} Py bytes=${pyBytes.length}`);
    // show first mismatch
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
  console.log(`OK byte-identical pack (${tsBytes.length} bytes)`);
  rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  console.error(e);
  process.exit(1);
}
