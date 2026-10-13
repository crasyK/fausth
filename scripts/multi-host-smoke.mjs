#!/usr/bin/env node
/**
 * Multi-host smoke: same coding-counterbalance harness + recorded model
 * on TS and Python; compare to committed golden.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

/**
 * Compare both host dumps with the golden. The golden's existence is checked
 * before anything is read (a missing golden is a clear failure, not ENOENT).
 * @param {{ goldenPath: string, tsDump: string, pyDump: string }} p
 * @returns {{ ok: boolean, messages: string[] }}
 */
export function compareToGolden(p) {
  /** @type {string[]} */
  const messages = [];
  if (!existsSync(p.goldenPath)) {
    return { ok: false, messages: [`FAIL missing golden ${p.goldenPath}`] };
  }
  for (const [label, file] of [
    ["TS", p.tsDump],
    ["Python", p.pyDump],
  ]) {
    if (!existsSync(file)) messages.push(`FAIL ${label} produced no dump (${file})`);
  }
  if (messages.length) return { ok: false, messages };
  const g = norm(readFileSync(p.goldenPath, "utf8"));
  const t = norm(readFileSync(p.tsDump, "utf8"));
  const py = norm(readFileSync(p.pyDump, "utf8"));
  let ok = true;
  const check = (cond, pass, fail) => {
    if (cond) messages.push(pass);
    else {
      messages.push(fail);
      ok = false;
    }
  };
  check(t === g, "OK TS ↔ golden", "FAIL TS dump ≠ golden");
  check(py === g, "OK Python ↔ golden", "FAIL Python dump ≠ golden");
  check(t === py, "OK TS ↔ Python", "FAIL TS ≠ Python");
  return { ok, messages };
}

function main() {
  if (!existsSync(golden)) {
    console.error(`missing golden ${golden}`);
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  const shell = process.platform === "win32";
  const ts = spawnSync(
    "pnpm",
    ["-C", "engines/ts", "exec", "node", "--import", "tsx", "src/cli.ts", "run", agent, "--deployment", dep, "--model", model, "--dump", tsDump],
    { cwd: root, encoding: "utf8", shell },
  );
  if (ts.status !== 0) {
    console.error(ts.error ? `pnpm: ${ts.error.message}` : ts.stderr || ts.stdout);
    process.exit(ts.status ?? 1);
  }
  const venvPython = join(root, ".venv", "bin", "python");
  const python = process.env.PYTHON ?? (existsSync(venvPython) ? venvPython : "python");
  const py = spawnSync(
    python,
    ["-m", "fausth", "run", agent, "--deployment", dep, "--model", model, "--dump", pyDump],
    { cwd: root, encoding: "utf8", shell },
  );
  if (py.status !== 0) {
    console.error(py.error ? `${python}: ${py.error.message}` : py.stderr || py.stdout);
    process.exit(py.status ?? 1);
  }
  const r = compareToGolden({ goldenPath: golden, tsDump, pyDump });
  for (const m of r.messages) (m.startsWith("OK") ? console.log : console.error)(m);
  process.exit(r.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
