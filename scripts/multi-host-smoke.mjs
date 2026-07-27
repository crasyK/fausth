#!/usr/bin/env node
/**
 * Multi-host smoke: same coding-counterbalance harness + recorded model
 * on TS and Python; compare to committed golden.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const agent = join(root, "examples/coding-counterbalance");
const dep = join(agent, "deployment.fixture.yml");
const model = join(agent, "smoke.model.jsonl");
const golden = join(agent, "smoke.expected.jsonl");
const outDir = join(root, "live/reports");
const tsDump = join(outDir, ".multi-host-ts.jsonl");
const pyDump = join(outDir, ".multi-host-py.jsonl");

function norm(s) {
  return s.replace(/\r\n/g, "\n");
}

mkdirSync(outDir, { recursive: true });

const ts = spawnSync(
  "pnpm",
  [
    "-C",
    "engines/ts",
    "exec",
    "node",
    "--import",
    "tsx",
    "src/cli.ts",
    "run",
    agent,
    "--deployment",
    dep,
    "--model",
    model,
    "--dump",
    tsDump,
  ],
  { cwd: root, encoding: "utf8", shell: true },
);
if (ts.status !== 0) {
  console.error(ts.stderr || ts.stdout);
  process.exit(ts.status ?? 1);
}

const py = spawnSync(
  "python",
  [
    "-m",
    "fausth",
    "run",
    agent,
    "--deployment",
    dep,
    "--model",
    model,
    "--dump",
    pyDump,
  ],
  { cwd: root, encoding: "utf8", shell: true },
);
if (py.status !== 0) {
  console.error(py.stderr || py.stdout);
  process.exit(py.status ?? 1);
}

const g = norm(readFileSync(golden, "utf8"));
const t = norm(readFileSync(tsDump, "utf8"));
const p = norm(readFileSync(pyDump, "utf8"));

let failed = 0;
if (t !== g) {
  console.error("FAIL TS dump ≠ smoke.expected.jsonl");
  failed = 1;
} else {
  console.log("OK TS ↔ golden");
}
if (p !== g) {
  console.error("FAIL Python dump ≠ smoke.expected.jsonl");
  failed = 1;
} else {
  console.log("OK Python ↔ golden");
}
if (t !== p) {
  console.error("FAIL TS ≠ Python");
  failed = 1;
} else {
  console.log("OK TS ↔ Python");
}

if (!existsSync(golden)) {
  console.error("missing smoke.expected.jsonl");
  failed = 1;
}

process.exit(failed);
