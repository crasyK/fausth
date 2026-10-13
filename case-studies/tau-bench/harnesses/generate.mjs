#!/usr/bin/env node
/**
 * Generates every τ-bench harness (agent.yml) from ONE tool surface plus a per-arm
 * contract, so arms can only differ in the contract (gates/sequences/limits),
 * never in tool names, schemas or descriptions.
 *
 * Tool surface (identical in every arm):
 *   tau.invoke     the 16 upstream retail APIs (names/arguments/descriptions verbatim
 *                  from ../world/tools.json); bound to the τ world command
 *   user.ask       channel: user — the only way to talk to the customer (D14);
 *                  checkpoint key `clarified` = the customer explicitly confirmed
 *   task.complete  end of conversation
 * No filesystem tools: the agent cannot read the DB/fixtures or write anything; all
 * DB changes go through the world's tools (CASE-7).
 *
 *   node case-studies/tau-bench/harnesses/generate.mjs           # write
 *   node case-studies/tau-bench/harnesses/generate.mjs --check   # fail on drift
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const require = createRequire(join(repoRoot, "engines/ts/package.json"));
const { stringify } = require("yaml");

export const MUTATING_TOOLS = [
  "cancel_pending_order",
  "exchange_delivered_order_items",
  "modify_pending_order_address",
  "modify_pending_order_items",
  "modify_pending_order_payment",
  "modify_user_address",
  "return_delivered_order_items",
];

function renderParam(name, p, required) {
  const type = p.enum ? p.enum.map((v) => JSON.stringify(v)).join(" | ") : p.type === "array" ? `${p.items?.type ?? "any"}[]` : p.type;
  return `${name}${required ? "" : "?"}: ${type}`;
}

/** tau.invoke description: upstream function specs rendered verbatim. */
export function tauInvokeDescription(specs) {
  const lines = [
    'Call ONE retail backend API per call: {"tool": <name>, "kwargs": {<arguments>}}. The API output is',
    "returned in `result` (failed calls: ok=0 and a result starting with \"Error:\"). APIs (names, arguments",
    "and descriptions verbatim from τ-bench retail):",
  ];
  for (const s of specs) {
    const f = s.function;
    const props = f.parameters?.properties ?? {};
    const req = new Set(f.parameters?.required ?? []);
    const sig = Object.entries(props)
      .map(([n, p]) => renderParam(n, p, req.has(n)))
      .join(", ");
    lines.push(`- ${f.name}(${sig}): ${f.description}`);
    for (const [n, p] of Object.entries(props)) {
      if (p.description) lines.push(`    ${n}: ${p.description}`);
    }
  }
  return lines.join("\n");
}

export function toolSurface() {
  const specs = JSON.parse(readFileSync(join(here, "../world/tools.json"), "utf8"));
  const names = specs.map((s) => s.function.name);
  return [
    {
      id: "tau.invoke",
      description: tauInvokeDescription(specs),
      input: {
        type: "object",
        required: ["tool", "kwargs"],
        additionalProperties: false,
        properties: {
          tool: { type: "string", enum: names },
          kwargs: { type: "object" },
        },
      },
      output: {
        type: "object",
        required: ["ok", "tool", "result"],
        additionalProperties: true,
        properties: {
          ok: { type: "integer" },
          tool: { type: "string" },
          kwargs: { type: "object" },
          result: { type: "string" },
          error: { type: "string" },
          exit_code: { type: "integer" },
          stderr: { type: "string" },
          truncated: { type: "integer" },
        },
      },
      verify: [{ kind: "evidence", require: { path: "result.ok", eq: 1 }, otherwise: "deny" }],
    },
    {
      id: "user.ask",
      channel: "user",
      description:
        "Send one message to the customer and wait for their reply (returned in `answer`). Everything the " +
        "customer should read goes through this tool. To ask the customer to confirm a consequential action, " +
        'describe the exact action and pass "set": {"clarified": 1}; the customer grants it only by explicitly ' +
        "agreeing. A reply of ###STOP### means the customer has ended the conversation.",
      input: {
        type: "object",
        required: ["message"],
        additionalProperties: false,
        properties: {
          message: { type: "string" },
          set: {
            type: "object",
            additionalProperties: false,
            properties: { clarified: { type: "integer", enum: [1] } },
          },
        },
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
      description: "End the conversation. Call once the customer's requests are handled or the customer has left.",
      input: { type: "object", additionalProperties: false, properties: {} },
      output: {
        type: "object",
        required: ["ok"],
        additionalProperties: false,
        properties: { ok: { type: "integer" } },
      },
    },
  ];
}

const CONFIRM_BEFORE_MUTATE = {
  id: "confirm-before-mutate",
  action: "tau.invoke",
  require_state: {
    any: [
      { path: "state.clarified", eq: 1 },
      { not: { any: MUTATING_TOOLS.map((t) => ({ path: "action.args.tool", eq: t })) } },
    ],
  },
};

function harness({ name, comment, limits, extraTools = [], mutable, sequences = [], invalidate = [] }) {
  const tools = [...toolSurface(), ...extraTools];
  const ir = {
    spec: "counterbalance-contract/v0.1",
    name,
    state: { clarified: 0 },
    ...(mutable ? { mutable } : {}),
    limits: { ...limits, continue_after_deny: true },
    tools,
    permissions: {
      tools: tools.map((t) => t.id),
      filesystem: { write_scopes: [], read_scopes: [] },
    },
    counterbalance: {
      ...(sequences.length ? { sequences } : {}),
      ...(invalidate.length ? { invalidate_after: invalidate } : {}),
      completion: { tool: "task.complete" },
      checkpoints: [{ tool: "user.ask", allow_set_keys: ["clarified"] }],
      orientation: { emit_each_step: true },
    },
  };
  return (
    "# GENERATED by case-studies/tau-bench/harnesses/generate.mjs — edit the generator, not this file.\n" +
    comment.map((l) => `# ${l}`).join("\n") +
    "\n" +
    stringify(ir, { lineWidth: 0, blockQuote: "literal" })
  );
}

const LIMITS = { max_steps: 30, max_tool_calls: 30 }; // upstream tool-calling agent: max_num_steps=30

const CB_RULES = {
  sequences: [CONFIRM_BEFORE_MUTATE],
  invalidate: [{ action: "tau.invoke", memory_keys: ["clarified"] }],
};

const REFLECT_TOOL = {
  id: "harness.reflect_skills",
  description:
    "End-of-attempt skills reflection before task.complete. Prefer decline unless one durable " +
    "tool-description heuristic is clear. propose ops=[{op:set_tool_description,tool_id,description}] " +
    "for an existing tool only.",
  input: {
    type: "object",
    required: ["disposition"],
    additionalProperties: false,
    properties: {
      disposition: { type: "string", enum: ["decline", "propose"] },
      reason: {
        type: "string",
        enum: ["no_new_heuristic", "insufficient_evidence", "would_overfit_task", "skills_already_adequate"],
      },
      note: { type: "string" },
      ops: {
        type: "array",
        minItems: 1,
        maxItems: 1,
        items: {
          type: "object",
          required: ["op", "tool_id", "description"],
          additionalProperties: false,
          properties: {
            op: { type: "string", enum: ["set_tool_description"] },
            tool_id: { type: "string" },
            description: { type: "string" },
          },
        },
      },
    },
  },
  output: {
    type: "object",
    required: ["ok", "disposition"],
    additionalProperties: false,
    properties: {
      ok: { type: "integer" },
      disposition: { type: "string" },
      proposed: { type: "integer" },
      declined: { type: "integer" },
    },
  },
};

export const ARMS = {
  "permissive-control": {
    name: "tau-retail-permissive-control",
    comment: [
      "τ-bench retail PERMISSIVE CONTROL: the CB tool surface with no contract rules.",
      "Arms differ only in the contract (test: tests/tau-harnesses.test.mjs).",
    ],
    limits: LIMITS,
  },
  counterbalanced: {
    name: "tau-retail-counterbalanced",
    comment: [
      "τ-bench retail COUNTERBALANCED = permissive control + one enforced rule:",
      "confirm-before-mutate — a mutating API call is allowed only while `clarified`=1, which only the",
      "customer (user channel, checkpoint key) can set by explicitly agreeing; any successful API call",
      "resets it, so the confirmation must directly precede each mutation. The contract cannot check",
      "WHAT the customer agreed to beyond that (honest limitation).",
    ],
    limits: LIMITS,
    ...CB_RULES,
  },
  "cb-budget": {
    name: "tau-retail-cb-budget",
    comment: ["Counterbalanced with a doubled step budget (lever: budget). Same tools and rules."],
    limits: { max_steps: 60, max_tool_calls: 60 },
    ...CB_RULES,
  },
  "cb-mutable": {
    name: "tau-retail-cb-mutable",
    comment: [
      "Counterbalanced + end-of-attempt skills reflection (lever: mutable skills).",
      "Tool surface = CB + harness.reflect_skills (the treatment); compare against counterbalanced, not PC.",
    ],
    limits: LIMITS,
    mutable: ["skills"],
    extraTools: [REFLECT_TOOL],
    sequences: [CONFIRM_BEFORE_MUTATE, { id: "reflect-before-complete", action: "task.complete", require_prior_tools: ["harness.reflect_skills"] }],
    invalidate: CB_RULES.invalidate,
  },
  "cb-optimize": {
    name: "tau-retail-cb-optimize",
    comment: ["Counterbalanced; an external optimizer may patch skills between tasks (dev split only)."],
    limits: LIMITS,
    ...CB_RULES,
  },
  "cb-tau-native": {
    name: "tau-retail-cb-tau-native",
    comment: [
      "Alias of counterbalanced (all τ harnesses now use the τ-native tau.invoke surface).",
      "Kept only as a stable fixture path for engine tests; not listed in any manifest.",
    ],
    limits: LIMITS,
    ...CB_RULES,
  },
};

export function renderAll() {
  const out = new Map();
  for (const [dir, spec] of Object.entries(ARMS)) out.set(join(here, dir, "agent.yml"), harness(spec));
  return out;
}

function main() {
  const check = process.argv.includes("--check");
  const drift = [];
  for (const [p, text] of renderAll()) {
    if (check) {
      if (!existsSync(p) || readFileSync(p, "utf8") !== text) drift.push(p);
      continue;
    }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  if (drift.length) {
    console.error(`harness drift: ${drift.join(", ")}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, harnesses: Object.keys(ARMS) }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
