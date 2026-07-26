import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
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

// TS: use replay which already checks expected; also dump actual via node script
const ts = spawnSync(
  "pnpm",
  ["-C", "engines/ts", "exec", "node", "--import", "tsx", "src/cli.ts", "replay"],
  { cwd: root, encoding: "utf8", shell: true },
);
if (ts.status !== 0) {
  console.error(ts.stdout, ts.stderr);
  process.exit(ts.status ?? 1);
}

const py = spawnSync("fausth-py", ["replay", "--dump-dir", outPy], {
  cwd: root,
  encoding: "utf8",
  shell: true,
});
if (py.status !== 0) {
  // try python -m
  const py2 = spawnSync("python", ["-m", "fausth", "replay", "--dump-dir", outPy], {
    cwd: root,
    encoding: "utf8",
    shell: true,
  });
  if (py2.status !== 0) {
    console.error(py.stdout, py.stderr, py2.stdout, py2.stderr);
    process.exit(py2.status ?? 1);
  }
}

// Compare dumps if present; else rely on both replays matching expected (transitive parity)
let compared = 0;
for (const name of dirs) {
  const a = join(outPy, `${name}.jsonl`);
  const exp = join(fixtures, name, "expected.jsonl");
  if (!existsSync(a)) continue;
  const pyLog = readFileSync(a, "utf8").replace(/\r\n/g, "\n");
  const expected = readFileSync(exp, "utf8").replace(/\r\n/g, "\n");
  if (pyLog !== expected) {
    console.error(`PARITY FAIL ${name}`);
    process.exit(1);
  }
  compared++;
}
console.log(`parity ok (${dirs.length} fixtures, ${compared} py dumps checked)`);
