/**
 * Shared engine launchers for scripts/parity.mjs and scripts/fuzz-ir.mjs.
 *
 * Python is never taken from PATH implicitly: the interpreter is
 * `$FAUSTH_PYTHON` or the repository's `.venv` python, launched with
 * `shell: false` and `PYTHONPATH=<repo>/engines/py`, and the imported
 * `fausth` package must live inside this checkout (an editable install of a
 * different checkout would otherwise be tested silently).
 */
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runnersDir = dirname(fileURLToPath(import.meta.url));

export class EngineSetupError extends Error {}

/** Resolve the Python interpreter for the twin engine (no PATH fallback). */
export function resolvePython(root = repoRoot) {
  const fromEnv = process.env.FAUSTH_PYTHON;
  if (fromEnv) {
    if (!existsSync(fromEnv) && !fromEnv.includes(sep)) {
      // A bare command name (e.g. CI: FAUSTH_PYTHON=python3) is allowed explicitly.
      return fromEnv;
    }
    if (!existsSync(fromEnv)) {
      throw new EngineSetupError(`FAUSTH_PYTHON=${fromEnv} does not exist`);
    }
    return fromEnv;
  }
  const candidates =
    process.platform === "win32"
      ? [join(root, ".venv", "Scripts", "python.exe")]
      : [join(root, ".venv", "bin", "python3"), join(root, ".venv", "bin", "python")];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new EngineSetupError(
    `No Python interpreter for the fausth twin: create ${join(root, ".venv")} ` +
      "(python -m venv .venv && .venv/bin/pip install -e 'engines/py[dev]') or set FAUSTH_PYTHON",
  );
}

export function pythonEnv(root = repoRoot) {
  const enginePath = join(root, "engines", "py");
  const prev = process.env.PYTHONPATH;
  return {
    ...process.env,
    PYTHONPATH: prev ? `${enginePath}${process.platform === "win32" ? ";" : ":"}${prev}` : enginePath,
    PYTHONIOENCODING: "utf-8",
    PYTHONDONTWRITEBYTECODE: "1",
  };
}

/** Fail loudly unless `import fausth` resolves to this checkout's engines/py. */
export function assertPythonEngine(python, root = repoRoot) {
  const r = spawnSync(python, ["-c", "import fausth, os; print(os.path.realpath(fausth.__file__))"], {
    cwd: root,
    env: pythonEnv(root),
    encoding: "utf8",
    shell: false,
  });
  if (r.error) throw new EngineSetupError(`cannot run ${python}: ${r.error.message}`);
  if (r.status !== 0) {
    throw new EngineSetupError(`${python} cannot import fausth:\n${r.stderr}`);
  }
  const where = r.stdout.trim();
  const expected = realpathSync(join(root, "engines", "py", "fausth"));
  if (!where.startsWith(expected + sep)) {
    throw new EngineSetupError(`fausth imported from ${where}, expected under ${expected}`);
  }
  return where;
}

function parseResults(stdout, what) {
  const out = new Map();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    out.set(r.id, r);
  }
  if (out.size === 0 && stdout.trim()) throw new Error(`${what}: unparsable output`);
  return out;
}

/** Run a batch of requests through the TypeScript runner. */
export function runTs(requests, root = repoRoot) {
  const input = requests.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const r = spawnSync(process.execPath, ["--import", "tsx", join(runnersDir, "ts-runner.ts")], {
    cwd: join(root, "engines", "ts"),
    input,
    encoding: "utf8",
    shell: false,
    maxBuffer: 1 << 30,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`ts-runner exited ${r.status}:\n${r.stderr}`);
  return parseResults(r.stdout, "ts-runner");
}

/** Run a batch of requests through the Python runner. */
export function runPy(requests, python, root = repoRoot) {
  const input = requests.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const r = spawnSync(python, [join(runnersDir, "py_runner.py")], {
    cwd: root,
    env: pythonEnv(root),
    input,
    encoding: "utf8",
    shell: false,
    maxBuffer: 1 << 30,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`py_runner exited ${r.status}:\n${r.stderr}`);
  return parseResults(r.stdout, "py_runner");
}

/** Run a Python CLI subcommand of the twin (shell-free). */
export function runPyCli(args, python, opts = {}) {
  const root = opts.root ?? repoRoot;
  return spawnSync(python, ["-m", "fausth", ...args], {
    cwd: opts.cwd ?? root,
    env: pythonEnv(root),
    encoding: "utf8",
    shell: false,
    maxBuffer: 1 << 30,
  });
}

/** Run a TS CLI subcommand (shell-free). */
export function runTsCli(args, opts = {}) {
  const root = opts.root ?? repoRoot;
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: join(root, "engines", "ts"),
    encoding: "utf8",
    shell: false,
    maxBuffer: 1 << 30,
  });
}

/** First differing position with surrounding lines, for readable diffs. */
export function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  for (; i < n; i++) {
    if (a[i] !== b[i]) break;
  }
  if (i === n && a.length === b.length) return null;
  const lineA = a.slice(0, i).split("\n").pop() + a.slice(i).split("\n")[0];
  const lineB = b.slice(0, i).split("\n").pop() + b.slice(i).split("\n")[0];
  return { byte: i, lineA, lineB };
}
