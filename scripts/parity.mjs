#!/usr/bin/env node
/**
 * Cross-engine parity suite: TypeScript engine ↔ Python twin.
 *
 * Sections (all by default; select with --only a,b,…):
 *   replay     Track A fixtures: TS ↔ PY ↔ golden expected.jsonl
 *   yaml       every *.yml under examples/, conformance/, case-studies/, worlds/
 *              parsed by both engines → canonical JSON
 *   load       examples/**: agent.yml → IR (agentYamlToIr) and `validate` CLI output
 *   inspect    examples/**: `inspect` CLI report (semantic JSON comparison)
 *   canonical  adversarial JSON texts → canonical encoding (or rejection)
 *   world      default replay world + deployment (simulation) world tool outputs
 *   schema     tool I/O schema validation incl. ajv-formats and JS `pattern`
 *   runtime    seeded random harness/transcript corpus replayed by both engines
 *
 * Python is `$FAUSTH_PYTHON` or the repository `.venv` interpreter (never an
 * implicit PATH lookup), run with `shell: false` and PYTHONPATH=engines/py; the
 * imported `fausth` must come from this checkout or the script fails.
 *
 * Usage: node scripts/parity.mjs [--only replay,yaml] [--report out.json]
 *        [--runtime-n 400] [--runtime-seed 20261012] [--astral] [--allow-known]
 *
 * Exit 0 only when every comparison is byte-identical (and, for replay, matches
 * the golden). Divergences that are known TS defects under the binding
 * decisions (D1 key order, D2 with --astral) are labelled; --allow-known exits 0
 * when nothing else differs (interim use until the TS fixes land).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  EngineSetupError,
  assertPythonEngine,
  firstDiff,
  repoRoot as root,
  resolvePython,
  runPy,
  runPyCli,
  runTs,
  runTsCli,
} from "../conformance/fuzz/runners/engines.mjs";
import { generateRuntimeCases } from "../conformance/fuzz/runners/gen-runtime.mjs";

function parseArgs(argv) {
  const out = { only: null, report: null, runtimeN: 400, runtimeSeed: 20261012, astral: false, allowKnown: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") out.only = new Set(String(argv[++i]).split(","));
    else if (a === "--report") out.report = argv[++i];
    else if (a === "--runtime-n") out.runtimeN = Number(argv[++i]);
    else if (a === "--runtime-seed") out.runtimeSeed = Number(argv[++i]);
    else if (a === "--astral") out.astral = true;
    else if (a === "--allow-known") out.allowKnown = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
const want = (s) => !opts.only || opts.only.has(s);

let python;
try {
  python = resolvePython(root);
  assertPythonEngine(python, root);
} catch (e) {
  if (e instanceof EngineSetupError) {
    console.error(`parity: ${e.message}`);
    process.exit(2);
  }
  throw e;
}

/** @type {Record<string, {checked: number, failures: {id: string, why: string}[]}>} */
const results = {};
function section(name) {
  results[name] = { checked: 0, failures: [] };
  return results[name];
}
function fail(sec, id, why, known = null) {
  sec.failures.push({ id, why, ...(known ? { known } : {}) });
}

function walk(dir, pred, out = []) {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, pred, out);
    else if (pred(p)) out.push(p);
  }
  return out.sort();
}

function sameIgnoringKeyOrder(a, b) {
  const norm = (text) => {
    try {
      return text
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.stringify(canonicalize(JSON.parse(l))))
        .join("\n");
    } catch {
      return null;
    }
  };
  const na = norm(a);
  return na !== null && na === norm(b);
}

/**
 * Label divergences that are known TS defects under the binding decisions (still failures:
 * the promise is byte-identical logs). D1: TS sorts keys by UTF-16 units and JS objects put
 * integer-like keys first; Python sorts by code point.
 */
function classify(a, b) {
  if (sameIgnoringKeyOrder(a, b)) return "known TS divergence D1 (key order: UTF-16 / integer-like keys first)";
  return null;
}

function compareRunner(sec, requests, label = (r) => r.id) {
  const ts = runTs(requests, root);
  const py = runPy(requests, python, root);
  for (const r of requests) {
    sec.checked++;
    const a = ts.get(r.id);
    const b = py.get(r.id);
    if (!a || !b) {
      fail(sec, label(r), `missing result (ts=${Boolean(a)} py=${Boolean(b)})`);
      continue;
    }
    if (!a.ok || !b.ok) {
      if (a.ok !== b.ok) fail(sec, label(r), `TS ${a.ok ? "ok" : `error: ${a.error}`} ↔ PY ${b.ok ? "ok" : `error: ${b.error}`}`);
      continue;
    }
    if (a.out !== b.out) {
      const d = firstDiff(a.out, b.out);
      const known = classify(a.out, b.out) ?? (opts.astral && r.kind === "run" ? "astral corpus (D2: TS counts UTF-16 units)" : null);
      fail(
        sec,
        label(r),
        `${known ? `[${known}] ` : ""}TS ↔ PY differ at ${d.byte}\n    TS: ${d.lineA.slice(0, 400)}\n    PY: ${d.lineB.slice(0, 400)}`,
        known,
      );
    }
  }
}

// --- replay -------------------------------------------------------------------
if (want("replay")) {
  const sec = section("replay");
  const fixtures = join(root, "conformance/fixtures");
  const outTs = join(root, "live/reports/.parity-ts");
  const outPy = join(root, "live/reports/.parity-py");
  mkdirSync(outTs, { recursive: true });
  mkdirSync(outPy, { recursive: true });
  const dirs = readdirSync(fixtures, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  if (dirs.length === 0) {
    console.error("No fixtures");
    process.exit(1);
  }
  const ts = runTsCli(["replay", "--dump-dir", outTs]);
  const py = runPyCli(["replay", "--dump-dir", outPy], python);
  if (ts.error || py.error) throw ts.error ?? py.error;
  sec.golden = { ts_failed: [], py_failed: [] };
  for (const name of dirs) {
    sec.checked++;
    const tsPath = join(outTs, `${name}.jsonl`);
    const pyPath = join(outPy, `${name}.jsonl`);
    if (!existsSync(tsPath) || !existsSync(pyPath)) {
      fail(sec, name, `missing dump (ts=${existsSync(tsPath)} py=${existsSync(pyPath)})`);
      continue;
    }
    const tsLog = readFileSync(tsPath, "utf8").replace(/\r\n/g, "\n");
    const pyLog = readFileSync(pyPath, "utf8").replace(/\r\n/g, "\n");
    const expected = readFileSync(join(fixtures, name, "expected.jsonl"), "utf8").replace(/\r\n/g, "\n");
    if (tsLog !== expected) sec.golden.ts_failed.push(name);
    if (pyLog !== expected) sec.golden.py_failed.push(name);
    if (tsLog !== pyLog) {
      const d = firstDiff(tsLog, pyLog);
      fail(sec, name, `TS ↔ PY differ at byte ${d.byte}\n    TS: ${d.lineA.slice(0, 400)}\n    PY: ${d.lineB.slice(0, 400)}`);
    } else if (tsLog !== expected) {
      const d = firstDiff(tsLog, expected);
      fail(sec, name, `engines agree but ≠ golden at byte ${d.byte}\n    got: ${d.lineA.slice(0, 400)}\n    exp: ${d.lineB.slice(0, 400)}`);
    }
  }
}

// --- yaml -----------------------------------------------------------------------
if (want("yaml")) {
  const sec = section("yaml");
  const files = ["examples", "conformance", "case-studies", "worlds"].flatMap((d) =>
    walk(join(root, d), (p) => /\.ya?ml$/i.test(p)),
  );
  const reqs = files.map((f, i) => ({ id: `y${i}`, kind: "yaml", text: readFileSync(f, "utf8"), file: relative(root, f) }));
  const adversarial = [
    "a: yes\nb: on\nc: off\nd: y\ne: No",
    "a: 1.0\nb: 1e3\nc: 010\nd: 0o10\ne: 0x1F\nf: 0b1\ng: 1_000\nh: 1:20\ni: 2001-12-14",
    "on: 1\ntrue: 2\n~: 3\n1.5: 4\n0x10: 5",
    "base: &b {x: 1}\nm:\n  <<: *b\n  y: 2",
    "a: !!int '7'\nb: !!float 1\nc: !foo 12\nd: ! 12\ne: !!bool yes",
    'a: "\\ud83d\\ude00"\nb: "x\\r\\ny"\nc: |\n  l1\n  l2\n',
    "a: 1\na: 2",
    "1: a\n1.0: b",
    "%YAML 1.2\n---\na: yes",
  ];
  adversarial.forEach((text, i) => reqs.push({ id: `ya${i}`, kind: "yaml", text, file: `<adversarial ${i}>` }));
  compareRunner(sec, reqs, (r) => r.file);
}

// --- load / validate / inspect ------------------------------------------------------
const harnessDirs = walk(join(root, "examples"), (p) => /[\\/]agent\.yml$/.test(p)).map((p) => join(p, ".."));

if (want("load")) {
  const sec = section("load");
  const reqs = harnessDirs.map((d, i) => ({
    id: `l${i}`,
    kind: "agent_yaml",
    text: readFileSync(join(d, "agent.yml"), "utf8"),
    dir: relative(root, d),
  }));
  compareRunner(sec, reqs, (r) => `agent_yaml ${r.dir}`);
  for (const d of harnessDirs) {
    sec.checked++;
    const rel = relative(root, d);
    const ts = runTsCli(["validate", d]);
    const py = runPyCli(["validate", d], python);
    if (ts.status !== py.status || ts.stdout.trim() !== py.stdout.trim()) {
      const dd = firstDiff(ts.stdout, py.stdout) ?? { byte: -1, lineA: ts.stderr.trim(), lineB: py.stderr.trim() };
      fail(sec, `validate ${rel}`, `exit TS=${ts.status} PY=${py.status}; first diff ${dd.byte}\n    TS: ${dd.lineA.slice(0, 300)}\n    PY: ${dd.lineB.slice(0, 300)}`);
    }
  }
}

function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonicalize(v[k]);
    return out;
  }
  return v;
}

if (want("inspect")) {
  const sec = section("inspect");
  for (const d of harnessDirs) {
    sec.checked++;
    const rel = relative(root, d);
    const ts = runTsCli(["inspect", d]);
    const py = runPyCli(["inspect", d], python);
    let a;
    let b;
    try {
      a = JSON.stringify(canonicalize(JSON.parse(ts.stdout)), null, 0);
      b = JSON.stringify(canonicalize(JSON.parse(py.stdout)), null, 0);
    } catch {
      fail(sec, rel, `unparsable inspect output (TS exit ${ts.status}, PY exit ${py.status})\n    TS: ${ts.stderr.trim().slice(0, 200)}\n    PY: ${py.stderr.trim().slice(0, 200)}`);
      continue;
    }
    if (ts.status !== py.status || a !== b) {
      const dd = firstDiff(a, b) ?? { byte: -1, lineA: "", lineB: "" };
      fail(sec, rel, `exit TS=${ts.status} PY=${py.status}; report differs at ${dd.byte}\n    TS: …${a.slice(Math.max(0, dd.byte - 60), dd.byte + 120)}\n    PY: …${b.slice(Math.max(0, dd.byte - 60), dd.byte + 120)}`);
    }
  }
}

// --- canonical encoding of adversarial values --------------------------------------
if (want("canonical")) {
  const sec = section("canonical");
  const texts = [
    '{"b":1,"a":2}',
    '{"x":1.0,"y":1e3,"z":-0.0,"w":1E+2}',
    '{"x":1.5}',
    '{"x":9007199254740991}',
    '{"x":9007199254740992}',
    '{"x":-9007199254740991}',
    '{"a":null,"b":[null,{"c":null}],"d":{}}',
    '{"crlf":"a\\r\\nb","tab":"\\t","ctl":"\\u0001\\u001f","del":"\\u007f","ls":"\\u2028"}',
    '{"\\ud83d\\ude00":1,"\\uff01":2,"a":3}',
    '{"10":1,"9":2,"a":3,"01":4}',
    '{"lone":"\\ud83d","pair":"\\ud83d\\ude00"}',
    '[1.0,2.5]',
    '{"nested":{"deep":[{"k":1e2}]}}',
    '"\\u00e9\\u0301"',
    "true",
    "null",
  ];
  compareRunner(
    sec,
    texts.map((json_text, i) => ({ id: `c${i}`, kind: "canonical", json_text })),
    (r) => r.json_text,
  );
}

// --- default worlds --------------------------------------------------------------------
if (want("world")) {
  const sec = section("world");
  const agents = {
    plain: { spec: "counterbalance-contract/v0.1", name: "w", state: {}, tools: [] },
    scoped: {
      spec: "counterbalance-contract/v0.1",
      name: "w",
      state: { temperature_decidegrees: 300, fan_percent: 20 },
      tools: [],
      permissions: {
        filesystem: { write_scopes: ["src/", "tests/"], read_scopes: ["src/", "docs"] },
        secrets: { paths: ["secrets/key.txt"], values: ["  sk-live-xyz  "] },
        protected_paths: ["src/app.js"],
      },
    },
    secretsOff: {
      spec: "counterbalance-contract/v0.1",
      name: "w",
      state: {},
      tools: [],
      permissions: { secrets: { deny_write_contains: true }, filesystem: { write_scopes: ["."] } },
    },
  };
  const calls = [
    { tool: "fs.read", args: { path: "src/app.ts" } },
    { tool: "fs.read", args: { path: "src/app.js" } },
    { tool: "fs.read", args: { path: "secrets/key.txt" } },
    { tool: "fs.read", args: { path: "docs/readme.md" } },
    { tool: "fs.read", args: {} },
    { tool: "fs.list", args: { path: "src" } },
    { tool: "fs.list", args: { path: "" } },
    { tool: "fs.write_scoped", args: { path: "src/new.ts", content: "x" } },
    { tool: "fs.write_scoped", args: { path: "src/leak.ts", content: "key=sk-fixture-secret-0001" } },
    { tool: "fs.write_scoped", args: { path: "src/leak2.ts", content: "sk-live-xyz" } },
    { tool: "fs.write_scoped", args: { path: "src/app.js", content: "tampered" } },
    { tool: "fs.write_scoped", args: { path: "lib/out.ts", content: "x" } },
    { tool: "fs.write_scoped", args: { path: "tau/todos.json", content: '{"slots":[{"value":1}]}' } },
    { tool: "shell.run_allowlisted", args: { cmd: "test" } },
    { tool: "shell.run_allowlisted", args: { cmd: "typecheck" } },
    { tool: "shell.run_allowlisted", args: { cmd: "rm -rf /" } },
    { tool: "user.approve", args: {} },
    { tool: "user.ask", args: { question: "refund or replacement?" } },
    { tool: "user.ask", args: { answer: "replacement", question: "q" } },
    { tool: "user.correct", args: { set: { open_todos: 0 } } },
    { tool: "task.complete", args: {} },
    { tool: "phase.yield", args: {} },
    { tool: "kb.lookup", args: { query: "refund policy and much more text here" } },
    { tool: "kb.lookup", args: {} },
    { tool: "answer.send", args: { text: "hi" } },
    { tool: "human.handoff", args: {} },
    { tool: "refund.request", args: {} },
    { tool: "harness.propose_skills_patch", args: {} },
    { tool: "harness.decline_skills_patch", args: {} },
    { tool: "harness.reflect_skills", args: { disposition: "propose" } },
    { tool: "harness.reflect_skills", args: { disposition: "decline" } },
    { tool: "echo.ping", args: { message: true } },
    { tool: "echo.ping", args: {} },
    { tool: "agent.spawn", args: { tools: ["fs.read"] } },
    { tool: "sensor.temperature.read", args: {} },
    { tool: "actuator.fan.set", args: { percent: 55 } },
    { tool: "sensor.fan.read_percent", args: {} },
    { tool: "system.wait", args: { ms: 5 } },
    { tool: "tau.invoke", args: { tool: "x" } },
    { tool: "todo.complete", args: { id: "1" } },
  ];
  const reqs = [];
  for (const [name, agent] of Object.entries(agents)) {
    for (const world of ["replay", "simulation"]) {
      const simAgent = { ...agent, tools: [...new Set(calls.map((c) => c.tool))].filter((t) => !["echo.ping", "tau.invoke", "todo.complete"].includes(t)).map((id) => ({ id })) };
      reqs.push({ id: `${name}/${world}`, kind: "world", world, agent: world === "simulation" ? simAgent : agent, calls });
    }
  }
  compareRunner(sec, reqs);
}

// --- schema validation ----------------------------------------------------------------
if (want("schema")) {
  const sec = section("schema");
  const formats = ["date", "time", "date-time", "iso-time", "iso-date-time", "duration", "uri", "uri-reference", "uri-template", "url", "email", "hostname", "ipv4", "ipv6", "regex", "uuid", "json-pointer", "json-pointer-uri-fragment", "relative-json-pointer", "byte", "password", "binary", "int32", "int64", "float", "double", "no-such-format"];
  const values = ["", "a", "2020-02-29", "2021-02-29", "10:00:00Z", "23:59:60Z", "2020-01-01T10:00:00Z", "2020-01-01T10:00:00", "2020-01-01T10:00:00Z\n", "P1D", "P", "PT1H30M", "http://example.com/a?b#c", "x.com", "urn:isbn:1", "a b", "{+path}/x", "a@b.co", "a@b", "A@B.CO", "a@b.co\n", "é@b.co", "example.com", "-ex.com", "1.2.3.4", "256.1.1.1", "::1", "1::2::3", "^a+$", "(", "a\\Z", "123e4567-e89b-12d3-a456-426614174000", "/a~0b", "#/a%20b", "0#", "aGk=", "!!!", "!!!\n", " ", 0, 2147483648, -2147483649, 1.5, true, null];
  const reqs = [];
  let i = 0;
  for (const f of formats) for (const v of values) reqs.push({ id: `s${i++}`, kind: "schema", schema: { properties: { x: { format: f } } }, data: { x: v }, label: `${f} ${JSON.stringify(v)}` });
  const patterns = ["^[0-9]+$", "^\\d+$", "^\\w+$", "^\\s*$", "^a.c$", "^src/", "^(?<p>[a-z]+)\\/\\k<p>$", "\\bx\\b", "^\\u{1F600}$"];
  const pvals = ["123", "123\n", "abc", "a\nc", "a c", "src/x", "foo/foo", "a x b", " ", "﻿", "\x1c", "\u{1F600}", "١"];
  for (const p of patterns) for (const v of pvals) reqs.push({ id: `s${i++}`, kind: "schema", schema: { properties: { x: { type: "string", pattern: p } } }, data: { x: v }, label: `pattern ${p} ${JSON.stringify(v)}` });
  const shapes = [
    [undefined, 5], [{}, "x"], [{ properties: {} }, { extra: 1 }], [{ properties: {} }, []], [{ type: "integer" }, 1.0],
    [{ properties: { n: { type: "integer" } } }, { n: 2.5 }], [{ properties: { n: { type: "number" } } }, { n: 2.5 }],
    [{ properties: { s: { type: "string", minLength: 2 } } }, { s: "\u{1F600}" }], [{ properties: { a: { enum: [1, "1"] } } }, { a: true }],
    [{ properties: { a: { const: 1 } } }, { a: 1.0 }], [{ properties: { a: { type: "array", uniqueItems: true } } }, { a: [1, true] }],
  ];
  for (const [schema, data] of shapes) reqs.push({ id: `s${i++}`, kind: "schema", schema, data, label: `shape ${JSON.stringify(schema)} ${JSON.stringify(data)}` });
  compareRunner(sec, reqs, (r) => r.label);
}

// --- runtime differential corpus ------------------------------------------------------------
if (want("runtime")) {
  const sec = section("runtime");
  const cases = generateRuntimeCases(opts.runtimeSeed, opts.runtimeN, { astral: opts.astral });
  compareRunner(sec, cases);
}

// --- report ----------------------------------------------------------------------------------
let total = 0;
let unknown = 0;
for (const [name, r] of Object.entries(results)) {
  total += r.failures.length;
  const knownN = r.failures.filter((f) => f.known).length;
  unknown += r.failures.length - knownN;
  const status = r.failures.length
    ? `FAIL ${r.failures.length}/${r.checked}${knownN ? ` (${knownN} known TS divergences)` : ""}`
    : `ok ${r.checked}`;
  console.log(`parity ${name}: ${status}`);
  for (const f of r.failures.slice(0, 25)) console.log(`  - ${f.id}: ${f.why}`);
  if (r.failures.length > 25) console.log(`  … ${r.failures.length - 25} more`);
  if (r.golden) {
    console.log(`  golden: TS fails ${r.golden.ts_failed.length} [${r.golden.ts_failed.join(", ")}]`);
    console.log(`  golden: PY fails ${r.golden.py_failed.length} [${r.golden.py_failed.join(", ")}]`);
  }
}
if (opts.report) {
  mkdirSync(join(opts.report, ".."), { recursive: true });
  writeFileSync(opts.report, JSON.stringify(results, null, 2) + "\n");
}
if (total) {
  console.error(`parity failed (${total} mismatches, ${total - unknown} labelled as known TS divergences)`);
  process.exit(opts.allowKnown && unknown === 0 ? 0 : 1);
}
console.log("parity ok (TS ↔ Python ↔ golden)");
