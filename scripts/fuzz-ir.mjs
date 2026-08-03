#!/usr/bin/env node
/**
 * Seeded IR fuzz corpus + TS↔PY validate agreement.
 *
 * Usage:
 *   node scripts/fuzz-ir.mjs generate
 *   node scripts/fuzz-ir.mjs check
 *   node scripts/fuzz-ir.mjs          # generate + check
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fuzzRoot = join(root, "conformance/fuzz");
const casesDir = join(fuzzRoot, "cases");
const require = createRequire(join(root, "engines/ts/package.json"));

const SEED = 42;
const N_CASES = 48;

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
    // Near-miss: permissions tool not in tools[]
    agent.permissions.tools = [...toolIds, "shell.unrestricted"];
    // schema may still accept; structural may warn — keep as valid IR if schema allows
    expectValid = true;
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
    // Near-miss: missing required top-level name → empty
    agent.name = "";
    // schema may require minLength — treat as invalid if validate fails
    expectValid = true; // resolved by actual validate
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

function validateTs(agent) {
  const script = `
import { validateAgent } from "./src/validate.ts";
const agent = ${JSON.stringify(agent)};
const r = validateAgent(agent);
console.log(JSON.stringify({ ok: r.ok === true, errors: r.ok ? [] : r.errors }));
`;
  const tmp = join(root, "engines/ts/.fuzz-tmp-validate.mjs");
  // Use tsx inline via stdin-less file in engines/ts
  const tmpTs = join(root, "engines/ts/.fuzz-tmp-validate.ts");
  writeFileSync(
    tmpTs,
    `import { validateAgent } from "./src/validate.js";\nconst agent = ${JSON.stringify(agent)} as any;\nconst r = validateAgent(agent);\nconsole.log(JSON.stringify({ ok: r.ok === true, errors: r.ok ? [] : (r as any).errors }));\n`,
  );
  try {
    const out = execFileSync(
      process.execPath,
      ["--import", "tsx", tmpTs],
      { cwd: join(root, "engines/ts"), encoding: "utf8" },
    );
    return JSON.parse(out.trim().split(/\r?\n/).filter(Boolean).pop());
  } finally {
    try {
      require("node:fs").unlinkSync(tmpTs);
    } catch {
      /* ignore */
    }
  }
}

function validatePy(agent) {
  const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify(join(root, "engines/py"))})
from fausth.validate import validate_agent
agent = json.loads(sys.stdin.read())
ok, errors, warnings = validate_agent(agent)
print(json.dumps({"ok": bool(ok), "errors": list(errors or [])}))
`;
  const out = execFileSync("python3", ["-c", py], {
    cwd: root,
    encoding: "utf8",
    input: JSON.stringify(agent),
    env: {
      ...process.env,
      PYTHONPATH: join(root, "engines/py"),
    },
  });
  return JSON.parse(out.trim().split(/\r?\n/).filter(Boolean).pop());
}

function check() {
  if (!existsSync(casesDir)) generate();
  const files = readdirSync(casesDir).filter((f) => f.endsWith(".json")).sort();
  let agree = 0;
  let disagree = 0;
  let crashes = 0;
  /** @type {unknown[]} */
  const mismatches = [];

  for (const f of files) {
    const c = JSON.parse(readFileSync(join(casesDir, f), "utf8"));
    let ts;
    let py;
    try {
      ts = validateTs(c.agent);
    } catch (e) {
      crashes += 1;
      mismatches.push({ id: c.id, crash: "ts", error: String(e) });
      continue;
    }
    try {
      py = validatePy(c.agent);
    } catch (e) {
      crashes += 1;
      mismatches.push({ id: c.id, crash: "py", error: String(e) });
      continue;
    }
    if (Boolean(ts.ok) === Boolean(py.ok)) {
      agree += 1;
    } else {
      disagree += 1;
      mismatches.push({ id: c.id, ts, py });
    }
  }

  const report = {
    seed: SEED,
    n: files.length,
    agree,
    disagree,
    crashes,
    pass: disagree === 0 && crashes === 0,
    mismatches: mismatches.slice(0, 20),
  };
  writeFileSync(join(fuzzRoot, "last-check.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
}

const cmd = process.argv[2] ?? "all";
if (cmd === "generate") generate();
else if (cmd === "check") check();
else {
  generate();
  check();
}
