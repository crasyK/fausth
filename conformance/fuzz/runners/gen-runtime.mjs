/**
 * Seeded generator of random runtime cases (agent IR + recorded proposals) for
 * TS ↔ Python differential replay. Cases stay inside the canonical value
 * domain (integers only) so that any event-log difference is an engine
 * divergence, not a canonicalization crash.
 */

export function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rnd, xs) {
  return xs[Math.floor(rnd() * xs.length)];
}

function chance(rnd, p) {
  return rnd() < p;
}

function sample(rnd, xs, k) {
  const pool = [...xs];
  const out = [];
  while (pool.length && out.length < k) {
    out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  }
  return out;
}

const OBJ = (properties = {}, extra = {}) => ({ type: "object", properties, ...extra });

const TOOL_SPECS = {
  "fs.read": {
    read_only: true,
    input: OBJ({ path: { type: "string" } }, { required: ["path"] }),
    output: OBJ(
      { path: { type: "string" }, content: { type: "string" }, found: { type: "integer" }, error: { type: "string" } },
      { additionalProperties: true },
    ),
  },
  "fs.list": {
    read_only: true,
    input: OBJ({ path: { type: "string" } }, { required: ["path"] }),
    output: OBJ({}, { additionalProperties: true }),
  },
  "fs.write_scoped": {
    input: OBJ({ path: { type: "string" }, content: { type: "string" } }, { required: ["path"] }),
    output: OBJ({}, { additionalProperties: true }),
  },
  "shell.run_allowlisted": {
    input: OBJ({ cmd: { type: "string" } }, { required: ["cmd"] }),
    output: OBJ({}, { additionalProperties: true }),
  },
  "user.approve": { input: OBJ({}, { additionalProperties: true }), output: OBJ({ approved: { type: "integer" } }) },
  "user.ask": { input: OBJ({ question: { type: "string" } }, { additionalProperties: true }), output: OBJ({ answer: { type: "string" } }) },
  "user.correct": { input: OBJ({ set: { type: "object" } }, { additionalProperties: true }), output: OBJ({ ok: { type: "integer" } }) },
  "task.complete": { input: OBJ({}), output: OBJ({ ok: { type: "integer" } }) },
  "phase.yield": { input: OBJ({}, { additionalProperties: true }), output: OBJ({ ok: { type: "integer" } }) },
  "kb.lookup": {
    read_only: true,
    input: OBJ({ query: { type: "string" } }, { required: ["query"] }),
    output: OBJ({}, { additionalProperties: true }),
  },
  "answer.send": { input: OBJ({ text: { type: "string" }, message: { type: "string" } }), output: OBJ({ ok: { type: "integer" } }) },
  "human.handoff": { input: OBJ({}, { additionalProperties: true }), output: OBJ({ ok: { type: "integer" } }) },
  "refund.request": { input: OBJ({}, { additionalProperties: true }), output: OBJ({ ok: { type: "integer" } }) },
  "harness.propose_skills_patch": { input: OBJ({}, { additionalProperties: true }), output: OBJ({}, { additionalProperties: true }) },
  "harness.decline_skills_patch": { input: OBJ({}, { additionalProperties: true }), output: OBJ({}, { additionalProperties: true }) },
  "harness.reflect_skills": { input: OBJ({}, { additionalProperties: true }), output: OBJ({}, { additionalProperties: true }) },
  "echo.ping": { input: OBJ({}, { additionalProperties: true }), output: OBJ({}, { additionalProperties: true }) },
  "agent.spawn": { input: OBJ({}, { additionalProperties: true }), output: OBJ({}, { additionalProperties: true }) },
  "sensor.temperature.read": { read_only: true, input: OBJ({}), output: OBJ({ celsius_decidegrees: { type: "integer" } }) },
  "sensor.fan.read_percent": { read_only: true, input: OBJ({}), output: OBJ({ percent: { type: "integer" } }) },
  "actuator.fan.set": {
    input: OBJ({ percent: { type: "integer", minimum: 0, maximum: 100 } }, { required: ["percent"] }),
    output: OBJ({ ok: { type: "integer" }, percent: { type: "integer" } }),
  },
  "system.wait": { input: OBJ({ ms: { type: "integer" } }), output: OBJ({ waited_ms: { type: "integer" } }) },
  "custom.unbound": { input: OBJ({}, { additionalProperties: true }) },
};

const TOOL_IDS = Object.keys(TOOL_SPECS);

const STATE_KEYS = [
  "open_todos",
  "test_evidence_current",
  "plan_approved",
  "kb_cited",
  "clarified",
  "handoff",
  "fan_percent",
  "sensor_healthy",
  "temperature_decidegrees",
  "out_of_scope_writes",
];

const ASTRAL_PATHS = ["src/\u{1F600}.ts"];
const ASTRAL_TEXTS = ["emoji \u{1F600}\u{1F680} done"];
const ASTRAL_QUERIES = ["\u{1F600}".repeat(13)];

let PATHS = [
  "src/app.ts",
  "src/app.js",
  "src",
  "src/",
  "src/new.ts",
  "secrets/key.txt",
  "../etc/passwd",
  "/etc/passwd",
  "src/../x.ts",
  "./src/app.ts",
  "tests/a.test.ts",
  "",
  "docs/readme.md",
];

const SCOPES = ["src/", "src", "tests/", ".", "./", "*", "docs", "src/../etc", "/", "./src", "src//lib"];

let TEXTS = [
  "plain",
  "```js\nx()\n```",
  "line1\r\nline2",
  "sk-fixture-secret-0001",
  "",
  "x".repeat(30),
  "éèê",
];

function smallInt(rnd) {
  return pick(rnd, [0, 1, 2, 5, 40, 80, 81, 100, -1]);
}

function randPredicateLeaf(rnd) {
  const path = pick(rnd, [
    ...STATE_KEYS.map((k) => `state.${k}`),
    "action.args.percent",
    "action.args.path",
    "action.name",
    "action.args.missing",
    "result.ok",
    "result.exit_code",
    "result.out_of_scope",
    "result.secret_leak",
    "result.protected_modified",
    "observation.percent",
    "message.contains_code_fence",
    "message.length",
  ]);
  const op = pick(rnd, ["eq", "eq", "neq", "lte", "gte", "lt", "gt", "eq_path"]);
  if (op === "eq_path") return { path, eq_path: pick(rnd, ["action.args.percent", "observation.percent", "state.fan_percent"]) };
  if (op === "eq" || op === "neq") {
    return { path, [op]: pick(rnd, [0, 1, "fs.write_scoped", "actuator.fan.set", null, "src/app.ts"]) };
  }
  return { path, [op]: smallInt(rnd) };
}

function randPredicate(rnd, depth = 0) {
  if (depth < 2 && chance(rnd, 0.25)) {
    const kind = pick(rnd, ["all", "any", "not"]);
    if (kind === "not") return { not: randPredicate(rnd, depth + 1) };
    return { [kind]: [randPredicate(rnd, depth + 1), randPredicate(rnd, depth + 1)] };
  }
  return randPredicateLeaf(rnd);
}

function randVerify(rnd, toolId) {
  const kind = pick(rnd, ["evidence", "absence", "effect", "output"]);
  const v = { kind };
  if (kind === "effect") v.observe = pick(rnd, ["sensor.fan.read_percent", "fs.read", "sensor.temperature.read"]);
  if (kind === "evidence" && toolId === "shell.run_allowlisted") v.require = { path: "result.exit_code", eq: 0 };
  else if (kind === "absence") v.require = { path: pick(rnd, ["result.out_of_scope", "result.secret_leak", "result.protected_modified"]), eq: 0 };
  else if (kind === "output") v.require = { path: "message.contains_code_fence", eq: 0 };
  else v.require = randPredicate(rnd);
  if (chance(rnd, 0.6)) v.otherwise = pick(rnd, ["deny", "safe_state"]);
  return v;
}

function randArgs(rnd, toolId, agentToolIds, depth) {
  switch (toolId) {
    case "fs.read":
    case "fs.list":
      return chance(rnd, 0.9) ? { path: pick(rnd, PATHS) } : {};
    case "fs.write_scoped":
      return { path: pick(rnd, PATHS), content: pick(rnd, TEXTS) };
    case "shell.run_allowlisted":
      return { cmd: pick(rnd, ["test", "typecheck", "ls", "npm test"]) };
    case "user.ask":
      return chance(rnd, 0.5) ? { question: pick(rnd, TEXTS) } : { answer: "yes" };
    case "user.correct":
      return chance(rnd, 0.7)
        ? { set: Object.fromEntries(sample(rnd, ["open_todos", "plan_approved", "test_evidence_current"], 1 + Math.floor(rnd() * 2)).map((k) => [k, pick(rnd, [0, 1])])) }
        : { reason: "r" };
    case "harness.propose_skills_patch":
      return pick(rnd, [
        { ops: [{ op: "set_tool_description", tool_id: pick(rnd, agentToolIds), description: "d" }] },
        { ops: [{ op: "set_memory_note", key: "k", note: "n" }] },
        { ops: [{ op: "set_permissions_tools", tools: [] }] },
        { ops: [] },
        { ops: [{ op: "set_instinct_text", text: "calm" }] },
      ]);
    case "harness.decline_skills_patch":
      return pick(rnd, [{ reason: "no_new_heuristic" }, { reason: "bogus" }, { reason: "insufficient_evidence", note: "n" }]);
    case "harness.reflect_skills":
      return pick(rnd, [
        { disposition: "decline", reason: "skills_already_adequate" },
        { disposition: "propose", ops: [{ op: "set_tool_description", tool_id: pick(rnd, agentToolIds), description: "x" }] },
        { disposition: "maybe" },
      ]);
    case "kb.lookup":
      return { query: pick(rnd, ["refund policy", "a".repeat(40), ...QUERIES_EXTRA]) };
    case "answer.send":
      return chance(rnd, 0.5) ? { text: pick(rnd, TEXTS) } : { message: pick(rnd, TEXTS) };
    case "echo.ping":
      return pick(rnd, [{ message: "hi" }, {}, { message: 5 }, { message: true }, { message: [1, null, 2] }, { message: { a: 1 } }]);
    case "actuator.fan.set":
      return chance(rnd, 0.9) ? { percent: smallInt(rnd) } : { percent: "50" };
    case "system.wait":
      return { ms: pick(rnd, [0, 10, 100]) };
    case "agent.spawn": {
      const args = { tools: sample(rnd, [...agentToolIds, "shell.unrestricted"], 1 + Math.floor(rnd() * 2)) };
      if (chance(rnd, 0.3)) args.filesystem = { write_scopes: sample(rnd, SCOPES, 1) };
      if (chance(rnd, 0.2)) args.filesystem = { ...(args.filesystem ?? {}), read_scopes: sample(rnd, SCOPES, 1) };
      if (chance(rnd, 0.3)) args.limits = { max_steps: pick(rnd, [1, 2, 50]), max_tool_calls: pick(rnd, [1, 3, 50]) };
      if (chance(rnd, 0.2)) args.spawn_nested = true;
      if (depth < 1 && chance(rnd, 0.6)) {
        args.proposals = randProposals(rnd, args.tools, 1 + Math.floor(rnd() * 3), depth + 1, true);
      }
      return args;
    }
    default:
      return chance(rnd, 0.8) ? {} : { extra: 1 };
  }
}

function randProposals(rnd, toolIds, n, depth = 0, raw = false) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = rnd();
    if (r < 0.06) {
      out.push({ type: "stop", message: pick(rnd, TEXTS) });
      break;
    }
    if (raw && r < 0.1) {
      out.push(pick(rnd, [{ type: "invalid", reason: "no_tool_call", message: "hmm" }, { type: "invalid", reason: "x" }, null]));
      continue;
    }
    const tool = chance(rnd, 0.9) && toolIds.length ? pick(rnd, toolIds) : pick(rnd, ["mode.enter", "shell.unrestricted", ...TOOL_IDS]);
    const line = { type: "tool", name: tool, args: randArgs(rnd, tool, toolIds, depth) };
    if (!raw && chance(rnd, 0.05)) {
      delete line.name;
      line.tool = tool;
    }
    if (raw && chance(rnd, 0.1)) delete line.args;
    out.push(line);
  }
  return out;
}

/** Tools the deployment (simulation) pool can bind. */
const SIM_TOOL_IDS = TOOL_IDS.filter((id) => id !== "echo.ping" && id !== "custom.unbound");

export function generateRuntimeCase(rnd, i) {
  const world = chance(rnd, 0.8) ? "replay" : "simulation";
  const nTools = 2 + Math.floor(rnd() * 7);
  const toolIds = sample(rnd, world === "simulation" ? SIM_TOOL_IDS : TOOL_IDS, nTools);
  if (chance(rnd, 0.3) && !toolIds.includes("sensor.fan.read_percent")) toolIds.push("sensor.fan.read_percent");
  const tools = toolIds.map((id) => {
    const spec = structuredClone(TOOL_SPECS[id]);
    const t = { id, ...spec };
    if (chance(rnd, 0.15)) delete t.input;
    if (chance(rnd, 0.15)) delete t.output;
    if (chance(rnd, 0.3)) t.verify = [randVerify(rnd, id)];
    if (chance(rnd, 0.1)) t.description = "desc";
    return t;
  });
  const state = {};
  for (const k of sample(rnd, STATE_KEYS, 2 + Math.floor(rnd() * 5))) state[k] = pick(rnd, [0, 1, 250, 40]);
  const agent = {
    spec: "counterbalance-contract/v0.1",
    name: `rt-${i}`,
    state,
    tools,
  };
  if (chance(rnd, 0.7)) {
    agent.limits = {
      max_steps: pick(rnd, [3, 5, 8, 12, 30]),
      max_tool_calls: pick(rnd, [2, 4, 6, 20]),
    };
    if (chance(rnd, 0.5)) agent.limits.continue_after_deny = chance(rnd, 0.8);
  }
  if (chance(rnd, 0.7)) {
    agent.permissions = {};
    const r = rnd();
    if (r < 0.5) agent.permissions.tools = sample(rnd, toolIds, Math.max(1, toolIds.length - 1));
    else if (r < 0.65) agent.permissions.tools = [...toolIds];
    else if (r < 0.75) agent.permissions.tools = [...toolIds, "shell.unrestricted"];
    if (chance(rnd, 0.6)) {
      agent.permissions.filesystem = { write_scopes: sample(rnd, SCOPES, 1 + Math.floor(rnd() * 2)) };
      if (chance(rnd, 0.5)) agent.permissions.filesystem.read_scopes = sample(rnd, SCOPES, 1 + Math.floor(rnd() * 2));
    }
    if (chance(rnd, 0.3)) {
      agent.permissions.secrets = chance(rnd, 0.7) ? { paths: ["secrets/key.txt"] } : { values: ["  sk-live-1  "], deny_write_contains: chance(rnd, 0.8) };
    }
    if (chance(rnd, 0.2)) agent.permissions.protected_paths = ["src/app.js"];
  }
  if (chance(rnd, 0.4)) {
    agent.gates = [
      {
        id: "g1",
        when: { path: "action.name", eq: pick(rnd, toolIds) },
        require: randPredicate(rnd),
        ...(chance(rnd, 0.5) ? { otherwise: pick(rnd, ["deny", "safe_state"]) } : {}),
      },
    ];
  }
  if (chance(rnd, 0.25)) {
    agent.fallback_state = { fan_percent: 0 };
  }
  if (chance(rnd, 0.2) && toolIds.includes("actuator.fan.set")) {
    agent.recovery = {
      ...(chance(rnd, 0.7) ? { on: pick(rnd, ["verify_effect_failed", "gate_denied", "verify_evidence_failed"]) } : {}),
      execute: { tool: "actuator.fan.set", args: { percent: 0 } },
      verify: { kind: "effect", observe: "sensor.fan.read_percent", require: { path: "observation.percent", eq: 0 } },
    };
  }
  if (chance(rnd, 0.3)) {
    agent.spawn = pick(rnd, [{ allow: true }, { allow: false }, { allow: true, allow_nested: true }, { tighten_only: true }]);
  }
  if (chance(rnd, 0.3)) agent.mutable = sample(rnd, ["skills", "memory", "instincts"], 1 + Math.floor(rnd() * 2));
  if (chance(rnd, 0.75)) {
    const cb = {};
    if (chance(rnd, 0.5)) {
      cb.sequences = [
        {
          id: "s1",
          action: pick(rnd, toolIds),
          ...(chance(rnd, 0.7) ? { require_prior_tools: sample(rnd, toolIds, 1) } : {}),
          ...(chance(rnd, 0.3) ? { require_prior_any_of: sample(rnd, toolIds, 2) } : {}),
          ...(chance(rnd, 0.3) ? { require_state: randPredicate(rnd) } : {}),
        },
      ];
    }
    if (chance(rnd, 0.4)) {
      cb.invalidate_after = [];
      if (chance(rnd, 0.7)) cb.invalidate_after.push({ action: pick(rnd, toolIds), memory_keys: sample(rnd, STATE_KEYS, 1) });
      if (chance(rnd, 0.5)) cb.invalidate_after.push({ ttl_steps: pick(rnd, [1, 2, 3]), memory_keys: sample(rnd, STATE_KEYS, 1) });
    }
    if (chance(rnd, 0.4)) {
      cb.completion = {
        ...(chance(rnd, 0.8) ? { tool: pick(rnd, [...toolIds, "task.complete"]) } : {}),
        ...(chance(rnd, 0.8) ? { require: randPredicate(rnd) } : {}),
      };
    }
    if (chance(rnd, 0.3)) cb.checkpoints = [{ tool: pick(rnd, ["user.correct", ...toolIds]), allow_set_keys: sample(rnd, STATE_KEYS, 1) }];
    if (chance(rnd, 0.5)) cb.orientation = { emit_each_step: true };
    if (chance(rnd, 0.2)) cb.output_verifies = [{ kind: "output", require: { path: "message.contains_code_fence", eq: 0 }, ...(chance(rnd, 0.5) ? { otherwise: "deny" } : {}) }];
    if (chance(rnd, 0.2)) cb.memory_provenance = { [pick(rnd, STATE_KEYS)]: { status: "current", source: "world" } };
    if (chance(rnd, 0.2)) cb.intervention_budget = { max_activations: pick(rnd, [1, 2, 3]), ...(chance(rnd, 0.3) ? { window: pick(rnd, ["run", "host_day"]) } : {}) };
    agent.counterbalance = cb;
  }
  const raw = chance(rnd, 0.15);
  const model_lines = randProposals(rnd, toolIds, 1 + Math.floor(rnd() * 9), 0, raw);
  return {
    id: `rt-${String(i).padStart(4, "0")}`,
    kind: "run",
    world,
    raw_proposals: raw,
    agent,
    model_lines,
  };
}

let QUERIES_EXTRA = [];

/**
 * @param {number} seed
 * @param {number} n
 * @param {{ astral?: boolean }} [opts] astral-plane strings exercise D2 (code-point
 *   lengths); off by default while the TS engine still counts UTF-16 units.
 */
export function generateRuntimeCases(seed, n, opts = {}) {
  const base = { PATHS, TEXTS, QUERIES_EXTRA };
  if (opts.astral) {
    PATHS = [...PATHS, ...ASTRAL_PATHS];
    TEXTS = [...TEXTS, ...ASTRAL_TEXTS];
    QUERIES_EXTRA = [...ASTRAL_QUERIES];
  }
  try {
    return generate(seed, n);
  } finally {
    ({ PATHS, TEXTS, QUERIES_EXTRA } = base);
  }
}

function generate(seed, n) {
  const rnd = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) out.push(generateRuntimeCase(rnd, i));
  return out;
}
