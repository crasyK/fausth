#!/usr/bin/env node
/**
 * IR fuzzing against EXPECTED verdicts (not only TS ↔ PY agreement).
 *
 * Usage:
 *   node scripts/fuzz-ir.mjs generate          # seeded validate corpus → conformance/fuzz/cases
 *   node scripts/fuzz-ir.mjs check             # both engines vs expect_valid_hint + agreement
 *   node scripts/fuzz-ir.mjs semantic          # conformance/fuzz/semantic/*.json expectations, per engine
 *   node scripts/fuzz-ir.mjs runtime [--n N] [--seed S]   # TS ↔ PY differential replay corpus
 *   node scripts/fuzz-ir.mjs                   # generate + check + semantic + runtime
 *
 * Python runs through conformance/fuzz/runners/engines.mjs ($FAUSTH_PYTHON or the
 * repository .venv, shell-free, engines/py on PYTHONPATH, location-checked).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EngineSetupError,
  assertPythonEngine,
  firstDiff,
  repoRoot as root,
  resolvePython,
  runPy,
  runTs,
} from "../conformance/fuzz/runners/engines.mjs";
import { generateRuntimeCases, mulberry32 } from "../conformance/fuzz/runners/gen-runtime.mjs";

const fuzzRoot = join(root, "conformance/fuzz");
const casesDir = join(fuzzRoot, "cases");
const semanticDir = join(fuzzRoot, "semantic");

const SEED = 42;
const N_CASES = 48;

const TOOL_POOL = [
  {
    id: "fs.read",
    read_only: true,
    input: {
      type: "object",
      required: ["path"],
      additionalProperties: false,
      properties: { path: { type: "string" } },
    },
    output: {
      type: "object",
      required: ["path", "found"],
      additionalProperties: true,
      properties: {
        path: { type: "string" },
        found: { type: "integer" },
        content: { type: "string" },
      },
    },
  },
  {
    id: "fs.write_scoped",
    input: {
      type: "object",
      required: ["path"],
      additionalProperties: false,
      properties: { path: { type: "string" }, content: { type: "string" } },
    },
    output: {
      type: "object",
      required: ["ok", "out_of_scope", "path"],
      additionalProperties: false,
      properties: {
        ok: { type: "integer" },
        out_of_scope: { type: "integer" },
        path: { type: "string" },
      },
    },
  },
  {
    id: "user.ask",
    input: {
      type: "object",
      additionalProperties: true,
      properties: { question: { type: "string" } },
    },
    output: {
      type: "object",
      required: ["answer"],
      additionalProperties: false,
      properties: { answer: { type: "string" } },
    },
  },
  {
    id: "task.complete",
    input: { type: "object", additionalProperties: false, properties: {} },
    output: {
      type: "object",
      required: ["ok"],
      additionalProperties: false,
      properties: { ok: { type: "integer" } },
    },
  },
];

/**
 * @param {() => number} rnd
 * @param {number} i
 */
function generateCase(rnd, i) {
  const kind = i % 6;
  const nTools = 1 + Math.floor(rnd() * TOOL_POOL.length);
  const tools = TOOL_POOL.slice(0, nTools).map((t) => structuredClone(t));
  const toolIds = tools.map((t) => t.id);

  /** @type {Record<string, unknown>} */
  const agent = {
    spec: "counterbalance-contract/v0.1",
    name: `fuzz-case-${String(i).padStart(3, "0")}`,
    state: { open_todos: Math.floor(rnd() * 2), flag: Math.floor(rnd() * 2) },
    tools,
    limits: {
      max_steps: 4 + Math.floor(rnd() * 12),
      max_tool_calls: 2 + Math.floor(rnd() * 8),
      continue_after_deny: rnd() > 0.5,
    },
    permissions: {
      tools: [...toolIds],
      filesystem: { read_scopes: ["src/"], write_scopes: ["src/"] },
    },
    counterbalance: {
      orientation: { emit_each_step: true },
    },
  };

  let expectValid = true;

  if (kind === 0) {
    // Near-miss: duplicate tool id
    tools.push(structuredClone(tools[0]));
    expectValid = false;
  } else if (kind === 1) {
    // Near-miss: permissions name a tool that is not declared (SPEC-16: invalid)
    agent.permissions.tools = [...toolIds, "shell.unrestricted"];
    expectValid = false;
  } else if (kind === 2) {
    // Near-miss: bad mutable cell
    agent.mutable = ["skills", "not-a-cell"];
    expectValid = false;
  } else if (kind === 3) {
    // Valid sequence when write present
    if (toolIds.includes("fs.write_scoped") && toolIds.includes("user.ask")) {
      agent.counterbalance.sequences = [
        {
          id: "ask-before-write",
          action: "fs.write_scoped",
          require_prior_tools: ["user.ask"],
        },
      ];
    }
    expectValid = true;
  } else if (kind === 4) {
    // Near-miss: empty name (schema: minLength 1)
    agent.name = "";
    expectValid = false;
  } else if (kind === 5) {
    // Valid completion gate
    if (toolIds.includes("task.complete")) {
      agent.counterbalance.completion = {
        tool: "task.complete",
        require: { path: "state.open_todos", eq: 0 },
      };
    }
    expectValid = true;
  }

  return {
    id: `fuzz-${String(i).padStart(3, "0")}`,
    seed: SEED,
    index: i,
    expect_valid_hint: expectValid,
    agent,
  };
}

function generate() {
  mkdirSync(casesDir, { recursive: true });
  const rnd = mulberry32(SEED);
  const index = [];
  for (let i = 0; i < N_CASES; i++) {
    const c = generateCase(rnd, i);
    const path = join(casesDir, `${c.id}.json`);
    writeFileSync(path, JSON.stringify(c, null, 2) + "\n");
    index.push({ id: c.id, path: `cases/${c.id}.json` });
  }
  writeFileSync(
    join(fuzzRoot, "manifest.json"),
    JSON.stringify({ seed: SEED, n: N_CASES, cases: index }, null, 2) + "\n",
  );
  console.log(`generated ${N_CASES} fuzz cases → ${casesDir}`);
}

let python;
function py() {
  if (!python) {
    python = resolvePython(root);
    assertPythonEngine(python, root);
  }
  return python;
}

function verdictOf(res) {
  if (!res) return { error: "missing result" };
  if (!res.ok) return { error: res.error };
  return JSON.parse(res.out);
}

function check() {
  if (!existsSync(casesDir)) generate();
  const files = readdirSync(casesDir).filter((f) => f.endsWith(".json")).sort();
  const cases = files.map((f) => JSON.parse(readFileSync(join(casesDir, f), "utf8")));
  const reqs = cases.map((c) => ({ id: c.id, kind: "validate", agent: c.agent }));
  const ts = runTs(reqs, root);
  const pr = runPy(reqs, py(), root);
  let agree = 0;
  let disagree = 0;
  let crashes = 0;
  const wrong = { ts: [], py: [] };
  /** @type {unknown[]} */
  const mismatches = [];
  for (const c of cases) {
    const a = verdictOf(ts.get(c.id));
    const b = verdictOf(pr.get(c.id));
    if (a.error || b.error) {
      crashes += 1;
      mismatches.push({ id: c.id, ts: a, py: b });
      continue;
    }
    if (a.ok === b.ok) agree += 1;
    else {
      disagree += 1;
      mismatches.push({ id: c.id, ts: a.ok, py: b.ok });
    }
    if (a.ok !== c.expect_valid_hint) wrong.ts.push(c.id);
    if (b.ok !== c.expect_valid_hint) wrong.py.push(c.id);
  }
  const report = {
    seed: SEED,
    n: cases.length,
    agree,
    disagree,
    crashes,
    expected_verdict_misses: wrong,
    pass: disagree === 0 && crashes === 0 && wrong.ts.length === 0 && wrong.py.length === 0,
    mismatches: mismatches.slice(0, 20),
  };
  writeFileSync(join(fuzzRoot, "last-check.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  return report.pass;
}

function getPath(obj, path) {
  let cur = obj;
  for (const p of path.split(".")) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, p)) {
      return { missing: true };
    }
    cur = cur[p];
  }
  return { value: cur };
}

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canonical(v[k]);
    return o;
  }
  return v;
}

/** Every key of `partial` deep-equals the event's value (deep subset for objects). */
function matches(event, partial) {
  for (const [k, v] of Object.entries(partial)) {
    if (!Object.prototype.hasOwnProperty.call(event, k)) return false;
    if (JSON.stringify(canonical(event[k])) !== JSON.stringify(canonical(v))) return false;
  }
  return true;
}

/** @returns {string[]} problems (empty = expectation met) */
function evaluate(c, res) {
  const exp = c.expect ?? {};
  if (!res) return ["no result"];
  if (exp.error) return res.ok ? [`expected rejection, got ${res.out}`] : [];
  if (!res.ok) return [`engine error: ${res.error}`];
  if (c.kind === "validate") {
    const v = JSON.parse(res.out);
    return v.ok === exp.ok ? [] : [`validate ok=${v.ok}, expected ${exp.ok}`];
  }
  if (c.kind === "yaml" || c.kind === "canonical") {
    return res.out === exp.out ? [] : [`got ${res.out}, expected ${exp.out}`];
  }
  const events = res.out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const problems = [];
  let from = 0;
  for (const partial of exp.contains ?? []) {
    const idx = events.findIndex((e, i) => i >= from && matches(e, partial));
    if (idx < 0) problems.push(`missing event ${JSON.stringify(partial)}`);
    else from = idx + 1;
  }
  for (const partial of exp.absent ?? []) {
    if (events.some((e) => matches(e, partial))) problems.push(`unexpected event ${JSON.stringify(partial)}`);
  }
  for (const { match, path } of exp.absent_paths ?? []) {
    for (const e of events.filter((ev) => matches(ev, match))) {
      if (!getPath(e, path).missing) problems.push(`event ${e.seq} has ${path}`);
    }
  }
  for (const { match, n } of exp.count ?? []) {
    const got = events.filter((e) => matches(e, match)).length;
    if (got !== n) problems.push(`${JSON.stringify(match)} occurs ${got}×, expected ${n}`);
  }
  return problems;
}

function semantic() {
  const files = readdirSync(semanticDir).filter((f) => f.endsWith(".json")).sort();
  const cases = files.map((f) => JSON.parse(readFileSync(join(semanticDir, f), "utf8")));
  const ts = runTs(cases, root);
  const pr = runPy(cases, py(), root);
  const report = { n: cases.length, ts_failed: [], py_failed: [] };
  for (const c of cases) {
    const label = `${c.id}${c.finding ? ` [${c.finding}]` : ""}${c.decision ? ` [${c.decision}]` : ""}`;
    const tsProblems = evaluate(c, ts.get(c.id));
    const pyProblems = evaluate(c, pr.get(c.id));
    if (tsProblems.length) report.ts_failed.push({ case: label, problems: tsProblems });
    if (pyProblems.length) report.py_failed.push({ case: label, problems: pyProblems });
  }
  report.pass = report.ts_failed.length === 0 && report.py_failed.length === 0;
  writeFileSync(join(fuzzRoot, "last-semantic.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(
    `semantic: ${cases.length} cases — TS misses ${report.ts_failed.length}, PY misses ${report.py_failed.length}`,
  );
  for (const [engine, list] of [["TS", report.ts_failed], ["PY", report.py_failed]]) {
    for (const f of list) console.log(`  ${engine} ${f.case}: ${f.problems.join("; ").slice(0, 300)}`);
  }
  return report.pass;
}

function runtime(args) {
  const n = Number(args[args.indexOf("--n") + 1] ?? 200) || 200;
  const seed = Number(args[args.indexOf("--seed") + 1] ?? 20261012) || 20261012;
  const cases = generateRuntimeCases(seed, n, { astral: args.includes("--astral") });
  const ts = runTs(cases, root);
  const pr = runPy(cases, py(), root);
  let same = 0;
  const diffs = [];
  for (const c of cases) {
    const a = ts.get(c.id);
    const b = pr.get(c.id);
    if (a.ok && b.ok && a.out === b.out) same += 1;
    else if (!a.ok && !b.ok) same += 1;
    else {
      const d = a.ok && b.ok ? firstDiff(a.out, b.out) : { byte: -1, lineA: a.error ?? "", lineB: b.error ?? "" };
      diffs.push({ id: c.id, byte: d.byte, ts: d.lineA.slice(0, 300), py: d.lineB.slice(0, 300) });
    }
  }
  const report = { seed, n, same, differ: diffs.length, pass: diffs.length === 0, first: diffs.slice(0, 10) };
  writeFileSync(join(fuzzRoot, "last-runtime.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`runtime: ${n} cases (seed ${seed}) — identical ${same}, differ ${diffs.length}`);
  for (const d of diffs.slice(0, 5)) console.log(`  ${d.id} @${d.byte}\n    TS: ${d.ts}\n    PY: ${d.py}`);
  return report.pass;
}

const [cmd = "all", ...rest] = process.argv.slice(2);
try {
  let ok = true;
  if (cmd === "generate") generate();
  else if (cmd === "check") ok = check();
  else if (cmd === "semantic") ok = semantic();
  else if (cmd === "runtime") ok = runtime(rest);
  else {
    generate();
    ok = check() && ok;
    ok = semantic() && ok;
    ok = runtime(rest) && ok;
  }
  if (!ok) process.exitCode = 1;
} catch (e) {
  if (e instanceof EngineSetupError) {
    console.error(`fuzz-ir: ${e.message}`);
    process.exit(2);
  }
  throw e;
}
