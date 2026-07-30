/**
 * Generate Counterbalance coding vertical-slice Track A fixtures and freeze expected.jsonl.
 *
 * Track A is mode-free: a harness advertises exactly the tools it may use, and ordering comes
 * from sequences, freshness invalidation and completion gates — never from a mode register.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FaustRuntime, eventsToJsonl } from "./runtime.js";
import { createCodingTools } from "./tools/world.js";
import { canonicalJson } from "./canonical.js";
import type { AgentIR, ModelProposal, RecordedToolCall, ToolDef } from "./types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixturesRoot = join(root, "conformance/fixtures");

const codingToolDefs: Record<string, ToolDef> = {
  "fs.read": {
    id: "fs.read",
    read_only: true,
    input: { type: "object", required: ["path"], additionalProperties: false, properties: { path: { type: "string" } } },
    output: {
      type: "object",
      required: ["path", "found"],
      additionalProperties: true,
      properties: { path: { type: "string" }, content: { type: "string" }, found: { type: "integer" } },
    },
  },
  "fs.write_scoped": {
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
      properties: { ok: { type: "integer" }, out_of_scope: { type: "integer" }, path: { type: "string" } },
    },
    verify: [{ kind: "absence", require: { path: "result.out_of_scope", eq: 0 }, otherwise: "safe_state" }],
  },
  "shell.run_allowlisted": {
    id: "shell.run_allowlisted",
    input: {
      type: "object",
      required: ["cmd"],
      additionalProperties: false,
      properties: { cmd: { type: "string" } },
    },
    output: {
      type: "object",
      required: ["exit_code", "cmd"],
      additionalProperties: true,
      properties: { exit_code: { type: "integer" }, cmd: { type: "string" }, error: { type: "string" } },
    },
    verify: [{ kind: "evidence", require: { path: "result.exit_code", eq: 0 }, otherwise: "deny" }],
  },
  "user.approve": {
    id: "user.approve",
    input: { type: "object", additionalProperties: true, properties: {} },
    output: {
      type: "object",
      required: ["approved"],
      additionalProperties: false,
      properties: { approved: { type: "integer" } },
    },
  },
  "user.correct": {
    id: "user.correct",
    input: {
      type: "object",
      additionalProperties: true,
      properties: {
        request: { type: "string" },
        reason: { type: "string" },
      },
    },
    output: {
      type: "object",
      required: ["ok"],
      additionalProperties: false,
      properties: { ok: { type: "integer" } },
    },
  },
  "task.complete": {
    id: "task.complete",
    input: { type: "object", additionalProperties: false, properties: {} },
    output: {
      type: "object",
      required: ["ok"],
      additionalProperties: false,
      properties: { ok: { type: "integer" } },
    },
  },
};

function codingTools(ids: string[]): ToolDef[] {
  return ids.map((id) => {
    const def = codingToolDefs[id];
    if (!def) throw new Error(`unknown coding tool: ${id}`);
    return def;
  });
}

/** Tools the full coding slice actually uses — no mode register, no blocked-tool advertising. */
const codingToolIds = [
  "fs.read",
  "fs.write_scoped",
  "shell.run_allowlisted",
  "user.approve",
  "user.correct",
  "task.complete",
];

function baseAgent(over: Partial<AgentIR> & { counterbalance?: AgentIR["counterbalance"] }): AgentIR {
  const agent: AgentIR = {
    spec: "counterbalance-contract/v0.1",
    name: "coding-counterbalance-slice",
    state: {
      researched: 0,
      plan_approved: 0,
      test_evidence_current: 0,
      open_todos: 1,
      out_of_scope_writes: 0,
    },
    tools: codingTools(codingToolIds),
    limits: { max_steps: 20, max_tool_calls: 16 },
    permissions: {
      tools: [...codingToolIds],
      filesystem: { write_scopes: ["src/"], read_scopes: ["src/"] },
    },
    counterbalance: {
      sequences: [
        {
          id: "plan-before-write",
          action: "fs.write_scoped",
          require_prior_tools: ["user.approve"],
        },
      ],
      invalidate_after: [
        { action: "fs.write_scoped", memory_keys: ["test_evidence_current"] },
      ],
      completion: {
        tool: "task.complete",
        require: {
          all: [
            { path: "state.test_evidence_current", eq: 1 },
            { path: "state.open_todos", eq: 0 },
          ],
        },
      },
      checkpoints: [
        {
          tool: "user.correct",
          allow_set_keys: ["open_todos"],
        },
      ],
      orientation: {
        emit_each_step: true,
      },
    },
    ...over,
  };
  return agent;
}

/**
 * Research-scoped harness: it can read and take user corrections, nothing else.
 * Writing is not a denied mode — the capability was simply never provisioned.
 */
function researchAgent(): AgentIR {
  return {
    spec: "counterbalance-contract/v0.1",
    name: "coding-counterbalance-research",
    state: {
      researched: 0,
      plan_approved: 0,
      test_evidence_current: 0,
      open_todos: 1,
      out_of_scope_writes: 0,
    },
    tools: codingTools(["fs.read", "user.correct"]),
    limits: { max_steps: 20, max_tool_calls: 16 },
    permissions: {
      tools: ["fs.read", "user.correct"],
      filesystem: { read_scopes: ["src/"] },
    },
    counterbalance: {
      checkpoints: [{ tool: "user.correct", allow_set_keys: ["open_todos"] }],
      orientation: { emit_each_step: true },
    },
  };
}

async function materialize(
  name: string,
  agent: AgentIR,
  proposals: ModelProposal[],
  recorded: RecordedToolCall[],
): Promise<void> {
  const dir = join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.json"), canonicalJson(agent) + "\n");
  writeFileSync(
    join(dir, "model.jsonl"),
    proposals.map((p) => canonicalJson(p)).join("\n") + "\n",
  );
  writeFileSync(
    join(dir, "tools.jsonl"),
    recorded.map((r) => canonicalJson(r)).join("\n") + (recorded.length ? "\n" : ""),
  );

  let pi = 0;
  const rt = new FaustRuntime({
    agent: structuredClone(agent),
    propose: async () => (pi >= proposals.length ? { type: "stop" } : proposals[pi++]!),
    tools: createCodingTools({
      files: { "src/app.ts": "export {}" },
      write_scopes: ["src/"],
      read_scopes: ["src/"],
      last_exit_code: 0,
      out_of_scope_writes: 0,
    }),
    recordedToolResults: recorded.length ? recorded : undefined,
  });
  await rt.runLoop();
  writeFileSync(join(dir, "expected.jsonl"), eventsToJsonl(rt.events));
  console.log("wrote", name, "events=", rt.events.length);
}

async function main(): Promise<void> {
  // Behaviour: write before plan approval denied by the plan-before-write sequence
  await materialize(
    "cb-write-before-plan-denied",
    baseAgent({
      state: {
        researched: 1,
        plan_approved: 0,
        test_evidence_current: 0,
        open_todos: 1,
        out_of_scope_writes: 0,
      },
    }),
    [{ type: "tool", name: "fs.write_scoped", args: { path: "src/app.ts", content: "x" } }],
    [],
  );

  // Awareness: stale test evidence blocks completion after write
  await materialize(
    "cb-stale-test-success",
    baseAgent({
      state: {
        researched: 1,
        plan_approved: 0,
        test_evidence_current: 0,
        open_todos: 0,
        out_of_scope_writes: 0,
      },
    }),
    [
      { type: "tool", name: "user.approve", args: {} },
      { type: "tool", name: "shell.run_allowlisted", args: { cmd: "test" } },
      { type: "tool", name: "fs.write_scoped", args: { path: "src/app.ts", content: "export const x=1" } },
      { type: "tool", name: "task.complete", args: {} },
    ],
    [
      {
        call_seq: 1,
        tool: "user.approve",
        args: {},
        result: {
          output: { approved: 1 },
          state_transition: { set: { plan_approved: 1 } },
        },
      },
      {
        call_seq: 2,
        tool: "shell.run_allowlisted",
        args: { cmd: "test" },
        result: {
          output: { exit_code: 0, cmd: "test" },
          state_transition: { set: { test_evidence_current: 1 } },
        },
      },
      {
        call_seq: 3,
        tool: "fs.write_scoped",
        args: { path: "src/app.ts", content: "export const x=1" },
        result: { output: { ok: 1, out_of_scope: 0, path: "src/app.ts" } },
      },
    ],
  );

  // Checkpoint integrity: model cannot self-author protected state via user.correct.
  await materialize(
    "cb-user-correction-cannot-be-self-authored",
    baseAgent({
      state: {
        researched: 1,
        plan_approved: 0,
        test_evidence_current: 0,
        open_todos: 1,
        out_of_scope_writes: 0,
      },
    }),
    [
      {
        type: "tool",
        name: "user.correct",
        args: { set: { plan_approved: 1, test_evidence_current: 1, open_todos: 0 } },
      },
    ],
    [],
  );

  // Behaviour: open todos block completion (ability+fresh evidence ok)
  await materialize(
    "cb-completion-open-todos-denied",
    baseAgent({
      state: {
        researched: 1,
        plan_approved: 1,
        test_evidence_current: 1,
        open_todos: 1,
        out_of_scope_writes: 0,
      },
    }),
    [{ type: "tool", name: "task.complete", args: {} }],
    [],
  );

  // Happy path: read → approve → write → test → clear todos → complete
  await materialize(
    "cb-coding-happy-path",
    baseAgent({}),
    [
      { type: "tool", name: "fs.read", args: { path: "src/app.ts" } },
      { type: "tool", name: "user.approve", args: {} },
      { type: "tool", name: "fs.write_scoped", args: { path: "src/app.ts", content: "export const ok=1" } },
      { type: "tool", name: "shell.run_allowlisted", args: { cmd: "test" } },
      { type: "tool", name: "user.correct", args: { request: "mark todos resolved" } },
      { type: "tool", name: "task.complete", args: {} },
    ],
    [
      {
        call_seq: 1,
        tool: "fs.read",
        args: { path: "src/app.ts" },
        result: {
          output: { path: "src/app.ts", content: "export {}", found: 1 },
          state_transition: { set: { researched: 1 } },
        },
      },
      {
        call_seq: 2,
        tool: "user.approve",
        args: {},
        result: {
          output: { approved: 1 },
          state_transition: { set: { plan_approved: 1 } },
        },
      },
      {
        call_seq: 3,
        tool: "fs.write_scoped",
        args: { path: "src/app.ts", content: "export const ok=1" },
        result: { output: { ok: 1, out_of_scope: 0, path: "src/app.ts" } },
      },
      {
        call_seq: 4,
        tool: "shell.run_allowlisted",
        args: { cmd: "test" },
        result: {
          output: { exit_code: 0, cmd: "test" },
          state_transition: { set: { test_evidence_current: 1 } },
        },
      },
      {
        call_seq: 5,
        tool: "user.correct",
        args: { request: "mark todos resolved" },
        result: { output: { ok: 1 }, state_transition: { set: { open_todos: 0 } } },
      },
      {
        call_seq: 6,
        tool: "task.complete",
        args: {},
        result: { output: { ok: 1 } },
      },
    ],
  );

  // Capability missing: the research harness never declares a write tool
  await materialize(
    "cb-write-not-provisioned",
    researchAgent(),
    [{ type: "tool", name: "fs.write_scoped", args: { path: "src/app.ts", content: "x" } }],
    [],
  );

  // Support: answer before kb denied
  const supportTools = [
    {
      id: "kb.lookup",
      read_only: true,
      input: {
        type: "object",
        required: ["query"],
        additionalProperties: false,
        properties: { query: { type: "string" } },
      },
      output: {
        type: "object",
        required: ["ok", "article_id"],
        additionalProperties: true,
        properties: { ok: { type: "integer" }, article_id: { type: "string" } },
      },
    },
    {
      id: "answer.send",
      input: {
        type: "object",
        required: ["text"],
        additionalProperties: false,
        properties: { text: { type: "string" } },
      },
      output: {
        type: "object",
        required: ["ok"],
        additionalProperties: false,
        properties: { ok: { type: "integer" } },
      },
    },
    {
      id: "human.handoff",
      input: { type: "object", additionalProperties: true, properties: { reason: { type: "string" } } },
      output: {
        type: "object",
        required: ["ok"],
        additionalProperties: false,
        properties: { ok: { type: "integer" } },
      },
    },
    {
      id: "user.correct",
      input: { type: "object", additionalProperties: true, properties: { set: { type: "object" } } },
      output: {
        type: "object",
        required: ["ok"],
        additionalProperties: false,
        properties: { ok: { type: "integer" } },
      },
    },
  ] as AgentIR["tools"];

  const supportAgent: AgentIR = {
    spec: "counterbalance-contract/v0.1",
    name: "support-bot-counterbalance",
    state: { kb_cited: 0, handoff: 0 },
    tools: supportTools,
    limits: { max_steps: 12, max_tool_calls: 10 },
    permissions: {
      tools: ["kb.lookup", "answer.send", "human.handoff", "user.correct"],
    },
    counterbalance: {
      sequences: [{ id: "kb-before-answer", action: "answer.send", require_prior_tools: ["kb.lookup"] }],
      completion: { tool: "answer.send", require: { path: "state.kb_cited", eq: 1 } },
    },
  };

  await materialize(
    "cb-support-answer-before-kb-denied",
    supportAgent,
    [{ type: "tool", name: "answer.send", args: { text: "Policy says refunds are free." } }],
    [],
  );

  await materialize(
    "cb-support-refund-capability-denied",
    supportAgent,
    [{ type: "tool", name: "refund.request", args: {} }],
    [],
  );

  await materialize(
    "cb-support-kb-then-answer",
    supportAgent,
    [
      { type: "tool", name: "kb.lookup", args: { query: "refund-policy" } },
      { type: "tool", name: "answer.send", args: { text: "Per article, refunds need review." } },
    ],
    [
      {
        call_seq: 1,
        tool: "kb.lookup",
        args: { query: "refund-policy" },
        result: {
          output: { ok: 1, article_id: "kb-refund-policy" },
          state_transition: { set: { kb_cited: 1 } },
        },
      },
      {
        call_seq: 2,
        tool: "answer.send",
        args: { text: "Per article, refunds need review." },
        result: { output: { ok: 1 } },
      },
    ],
  );

  // Opt-in: deny then recover with continue_after_deny
  await materialize(
    "cb-deny-then-recover",
    baseAgent({
      limits: { max_steps: 20, max_tool_calls: 16, continue_after_deny: true },
      state: {
        researched: 1,
        plan_approved: 0,
        test_evidence_current: 0,
        open_todos: 1,
        out_of_scope_writes: 0,
      },
    }),
    [
      { type: "tool", name: "fs.write_scoped", args: { path: "src/app.ts", content: "x" } },
      { type: "tool", name: "user.approve", args: {} },
      { type: "tool", name: "fs.write_scoped", args: { path: "src/app.ts", content: "export const ok=1" } },
      { type: "tool", name: "shell.run_allowlisted", args: { cmd: "test" } },
      { type: "tool", name: "user.correct", args: { request: "mark todos resolved" } },
      { type: "tool", name: "task.complete", args: {} },
    ],
    [
      {
        call_seq: 1,
        tool: "user.approve",
        args: {},
        result: {
          output: { approved: 1 },
          state_transition: { set: { plan_approved: 1 } },
        },
      },
      {
        call_seq: 2,
        tool: "fs.write_scoped",
        args: { path: "src/app.ts", content: "export const ok=1" },
        result: { output: { ok: 1, out_of_scope: 0, path: "src/app.ts" } },
      },
      {
        call_seq: 3,
        tool: "shell.run_allowlisted",
        args: { cmd: "test" },
        result: {
          output: { exit_code: 0, cmd: "test" },
          state_transition: { set: { test_evidence_current: 1 } },
        },
      },
      {
        call_seq: 4,
        tool: "user.correct",
        args: { request: "mark todos resolved" },
        result: { output: { ok: 1 }, state_transition: { set: { open_todos: 0 } } },
      },
      {
        call_seq: 5,
        tool: "task.complete",
        args: {},
        result: { output: { ok: 1 } },
      },
    ],
  );

  // Opt-in: repeated identical deny until max_steps
  await materialize(
    "cb-deny-then-repeat",
    baseAgent({
      limits: { max_steps: 3, max_tool_calls: 16, continue_after_deny: true },
      state: {
        researched: 1,
        plan_approved: 0,
        test_evidence_current: 0,
        open_todos: 1,
        out_of_scope_writes: 0,
      },
    }),
    [
      { type: "tool", name: "fs.write_scoped", args: { path: "src/app.ts", content: "x" } },
      { type: "tool", name: "fs.write_scoped", args: { path: "src/app.ts", content: "x" } },
      { type: "tool", name: "fs.write_scoped", args: { path: "src/app.ts", content: "x" } },
    ],
    [],
  );

  // Default remains terminal: same first deny without continue_after_deny stops the run
  await materialize(
    "cb-continue-after-deny-off",
    baseAgent({
      state: {
        researched: 1,
        plan_approved: 0,
        test_evidence_current: 0,
        open_todos: 1,
        out_of_scope_writes: 0,
      },
    }),
    [
      { type: "tool", name: "fs.write_scoped", args: { path: "src/app.ts", content: "x" } },
      { type: "tool", name: "user.approve", args: {} },
    ],
    [],
  );

  // Schema-valid out-of-scope read: informative found:0, then continue to in-scope read
  await materialize(
    "cb-read-out-of-scope-informative",
    baseAgent({
      limits: { max_steps: 20, max_tool_calls: 16, continue_after_deny: true },
    }),
    [
      { type: "tool", name: "fs.read", args: { path: "package.json" } },
      { type: "tool", name: "fs.read", args: { path: "src/app.ts" } },
    ],
    [
      {
        call_seq: 1,
        tool: "fs.read",
        args: { path: "package.json" },
        result: {
          output: { path: "package.json", content: "", found: 0, error: "scope_denied" },
        },
      },
      {
        call_seq: 2,
        tool: "fs.read",
        args: { path: "src/app.ts" },
        result: {
          output: { path: "src/app.ts", content: "export {}", found: 1 },
          state_transition: { set: { researched: 1 } },
        },
      },
    ],
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
