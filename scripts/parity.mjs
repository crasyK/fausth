import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "conformance/fixtures");
const outTs = join(root, "live/reports/.parity-ts");
const outPy = join(root, "live/reports/.parity-py");
mkdirSync(outTs, { recursive: true });
mkdirSync(outPy, { recursive: true });

const dirs = readdirSync(fixtures, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

if (dirs.length === 0) {
  console.error("No fixtures");
  process.exit(1);
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  for (; i < n; i++) {
    if (a[i] !== b[i]) break;
  }
  if (i === n && a.length === b.length) {
    return { byte: -1, lineA: "", lineB: "" };
  }
  const lineA = a.slice(0, i).split("\n").pop() + a.slice(i).split("\n")[0];
  const lineB = b.slice(0, i).split("\n").pop() + b.slice(i).split("\n")[0];
  return { byte: i, lineA, lineB };
}

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
    "replay",
    "--dump-dir",
    outTs,
  ],
  { cwd: root, encoding: "utf8", shell: true },
);
if (ts.status !== 0) {
  console.error(ts.stdout, ts.stderr);
  process.exit(ts.status ?? 1);
}

let py = spawnSync("fausth-py", ["replay", "--dump-dir", outPy], {
  cwd: root,
  encoding: "utf8",
  shell: true,
});
if (py.status !== 0) {
  py = spawnSync("python", ["-m", "fausth", "replay", "--dump-dir", outPy], {
    cwd: root,
    encoding: "utf8",
    shell: true,
  });
  if (py.status !== 0) {
    console.error(py.stdout, py.stderr);
    process.exit(py.status ?? 1);
  }
}

let failed = 0;
for (const name of dirs) {
  const tsPath = join(outTs, `${name}.jsonl`);
  const pyPath = join(outPy, `${name}.jsonl`);
  const expPath = join(fixtures, name, "expected.jsonl");
  if (!existsSync(tsPath) || !existsSync(pyPath)) {
    console.error(`PARITY FAIL ${name}: missing dump (ts=${existsSync(tsPath)} py=${existsSync(pyPath)})`);
    failed++;
    continue;
  }
  const tsLog = readFileSync(tsPath, "utf8").replace(/\r\n/g, "\n");
  const pyLog = readFileSync(pyPath, "utf8").replace(/\r\n/g, "\n");
  const expected = readFileSync(expPath, "utf8").replace(/\r\n/g, "\n");

  if (tsLog !== pyLog) {
    const d = firstDiff(tsLog, pyLog);
    console.error(`PARITY FAIL ${name}: TS ↔ Python differ at byte ${d.byte}`);
    console.error(`  TS: ${d.lineA}`);
    console.error(`  PY: ${d.lineB}`);
    failed++;
    continue;
  }
  if (tsLog !== expected) {
    const d = firstDiff(tsLog, expected);
    console.error(`PARITY FAIL ${name}: engines ↔ golden differ at byte ${d.byte}`);
    console.error(`  got: ${d.lineA}`);
    console.error(`  exp: ${d.lineB}`);
    failed++;
    continue;
  }
  console.log(`PARITY OK ${name}`);
}

if (failed) {
  console.error(`parity failed (${failed}/${dirs.length})`);
  process.exit(1);
}
console.log(`parity ok (${dirs.length} fixtures, TS ↔ Python ↔ golden)`);
