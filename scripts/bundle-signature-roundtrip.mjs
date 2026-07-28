#!/usr/bin/env node
/**
 * Prove TS ↔ Python signed packs are byte-identical for the same Ed25519 seed,
 * and that verify / unpack succeed on both engines. Also asserts unsigned coding
 * pack remains 15650 bytes.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "fausth-sig-rt-"));

function seedHexFromNode() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ type: "pkcs8", format: "der" });
  return der.subarray(der.length - 32).toString("hex");
}

function packSigned(engine, harness, out, seedPath) {
  if (engine === "ts") {
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "pack",
        harness,
        "--out",
        out,
        "--sign-key",
        seedPath,
      ],
      { cwd: join(root, "engines/ts"), stdio: "pipe", windowsHide: true },
    );
  } else {
    execFileSync(
      "python",
      ["-m", "fausth", "pack", harness, "--out", out, "--sign-key", seedPath],
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
}

function verify(engine, bundle) {
  if (engine === "ts") {
    execFileSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "verify", bundle],
      { cwd: join(root, "engines/ts"), stdio: "pipe", windowsHide: true },
    );
  } else {
    execFileSync("python", ["-m", "fausth", "verify", bundle], {
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
}

try {
  // Unsigned size lock
  const unsignedOut = join(tmp, "coding.unsigned.fausth.json");
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/cli.ts",
      "pack",
      join(root, "examples/coding-counterbalance"),
      "--out",
      unsignedOut,
    ],
    { cwd: join(root, "engines/ts"), stdio: "pipe", windowsHide: true },
  );
  const unsignedBytes = readFileSync(unsignedOut);
  if (unsignedBytes.length !== 15650) {
    throw new Error(`unsigned coding pack size ${unsignedBytes.length} != 15650`);
  }
  console.log("OK unsigned coding pack 15650 bytes");

  const seedPath = join(tmp, "seed.hex");
  writeFileSync(seedPath, seedHexFromNode() + "\n", "utf8");

  const harness = join(root, "examples/primitives/inline-file-connectors");
  const tsOut = join(tmp, "connectors.ts.fausth.json");
  const pyOut = join(tmp, "connectors.py.fausth.json");
  packSigned("ts", harness, tsOut, seedPath);
  packSigned("py", harness, pyOut, seedPath);

  const tsBytes = readFileSync(tsOut);
  const pyBytes = readFileSync(pyOut);
  if (!tsBytes.equals(pyBytes)) {
    writeFileSync(join(tmp, "ts.txt"), tsBytes);
    writeFileSync(join(tmp, "py.txt"), pyBytes);
    throw new Error(`signed TS/Python packs differ (artifacts in ${tmp})`);
  }
  const parsed = JSON.parse(tsBytes.toString("utf8"));
  if (!parsed.signature || parsed.signature.alg !== "ed25519") {
    throw new Error("missing ed25519 signature on packed bundle");
  }
  console.log(
    `OK signed connector pack byte-identical (${tsBytes.length} bytes, ${parsed.format})`,
  );

  verify("ts", tsOut);
  verify("py", tsOut);
  console.log("OK verify on TS and Python");

  // Cross-engine: Python verifies a TS-signed pack after file tamper fails
  const tampered = JSON.parse(tsBytes.toString("utf8"));
  tampered.files["agent.yml"] += "\n# no\n";
  const badPath = join(tmp, "bad.fausth.json");
  writeFileSync(badPath, JSON.stringify(tampered) + "\n", "utf8");
  let failed = false;
  try {
    verify("py", badPath);
  } catch {
    failed = true;
  }
  if (!failed) throw new Error("expected verify to fail on tampered pack");
  console.log("OK tampered pack rejected");

  rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  console.error(e);
  process.exit(1);
}
