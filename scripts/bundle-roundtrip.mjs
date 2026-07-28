#!/usr/bin/env node
/**
 * Prove TS pack ≡ Python pack for:
 * - coding-counterbalance (v0.1, legacy byte-identical)
 * - inline-file-connectors (v0.2, byte-identical with embedded resolved IR)
 * - mcp-connectors (v0.3, MCP descriptors)
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "fausth-roundtrip-"));

function packBoth(harness, label) {
  const tsOut = join(tmp, `${label}.ts.fausth.json`);
  execFileSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "pack", harness, "--out", tsOut],
    { cwd: join(root, "engines/ts"), stdio: "pipe", windowsHide: true },
  );
  const tsBytes = readFileSync(tsOut);

  const pyOut = join(tmp, `${label}.py.fausth.json`);
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
    writeFileSync(join(tmp, `${label}.ts.txt`), tsBytes);
    writeFileSync(join(tmp, `${label}.py.txt`), pyBytes);
    console.error(`${label}: TS and Python packs differ`);
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
    throw new Error(`${label} pack mismatch (artifacts in ${tmp})`);
  }
  const parsed = JSON.parse(tsBytes.toString("utf8"));
  console.log(`OK ${label} byte-identical pack (${tsBytes.length} bytes, ${parsed.format})`);
  return { bytes: tsBytes, format: parsed.format };
}

try {
  const coding = packBoth(join(root, "examples/coding-counterbalance"), "coding");
  if (coding.format !== "fausth-harness-bundle/v0.1") {
    throw new Error(`expected coding pack v0.1, got ${coding.format}`);
  }

  const connectors = packBoth(
    join(root, "examples/primitives/inline-file-connectors"),
    "connectors",
  );
  if (connectors.format !== "fausth-harness-bundle/v0.2") {
    throw new Error(`expected connector pack v0.2, got ${connectors.format}`);
  }

  const mcp = packBoth(join(root, "examples/primitives/mcp-connectors"), "mcp");
  if (mcp.format !== "fausth-harness-bundle/v0.3") {
    throw new Error(`expected mcp pack v0.3, got ${mcp.format}`);
  }

  rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  console.error(e);
  process.exit(1);
}
