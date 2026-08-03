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
  "user.ask": {
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
  "harness.propose_skills_patch": {
    id: "harness.propose_skills_patch",
    description:
      "Propose an allowlisted skills/memory/instincts harness patch (fixtures keep a loose ops schema)",
    input: {
      type: "object",
      required: ["ops"],
      additionalProperties: false,
      properties: {
        ops: { type: "array", minItems: 1, maxItems: 8, items: { type: "object", additionalProperties: true } },
      },
    },
    output: {
      type: "object",
      required: ["ok", "proposed"],
      additionalProperties: false,
      properties: { ok: { type: "integer" }, proposed: { type: "integer" } },
    },
  },
  "harness.decline_skills_patch": {
    id: "harness.decline_skills_patch",
    description:
      "Decline proposing a skills patch and record a structured reason (end-of-phase reflection)",
    input: {
      type: "object",
      required: ["reason"],
      additionalProperties: false,
      properties: {
        reason: {
          type: "string",
          enum: [
            "no_new_heuristic",
            "insufficient_evidence",
            "would_overfit_task",
            "skills_already_adequate",
          ],
        },
        note: { type: "string" },
      },
    },
    output: {
      type: "object",
      required: ["ok", "declined"],
      additionalProperties: false,
      properties: { ok: { type: "integer" }, declined: { type: "integer" } },
    },
  },
  "harness.reflect_skills": {
    id: "harness.reflect_skills",
    description:
      "End-of-phase skills reflection: disposition decline (reason) or propose (exactly one set_tool_description op)",
    input: {
      type: "object",
      required: ["disposition"],
      additionalProperties: false,
      properties: {
        disposition: { type: "string", enum: ["decline", "propose"] },
        reason: {
          type: "string",
          enum: [
            "no_new_heuristic",
            "insufficient_evidence",
            "would_overfit_task",
            "skills_already_adequate",
          ],
        },
        note: { type: "string" },
        ops: {
          type: "array",
          minItems: 1,
          maxItems: 1,
          items: { type: "object", additionalProperties: true },
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
  },
  "phase.yield": {
    id: "phase.yield",
    input: { type: "object", additionalProperties: false, properties: {} },
    output: {
      type: "object",
      required: ["ok"],
      additionalProperties: false,
      properties: { ok: { type: "integer" } },
    },
  },
  "echo.ping": {
    id: "echo.ping",
    input: {
      type: "object",
      additionalProperties: false,
      properties: { message: { type: "string" } },
    },
    output: {
      type: "object",
      required: ["ok", "echo"],
      additionalProperties: false,
      properties: { ok: { type: "integer" }, echo: { type: "string" } },
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
  worldOpts?: { write_scopes?: string[]; read_scopes?: string[]; files?: Record<string, string> },
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
  const writeScopes = worldOpts?.write_scopes ?? agent.permissions?.filesystem?.write_scopes ?? ["src/"];
  const readScopes = worldOpts?.read_scopes ?? agent.permissions?.filesystem?.read_scopes ?? writeScopes;
  const rt = new FaustRuntime({
    agent: structuredClone(agent),
    propose: async () => (pi >= proposals.length ? { type: "stop" } : proposals[pi++]!),
    tools: createCodingTools({
      files: worldOpts?.files ?? { "src/app.ts": "export {}" },
      write_scopes: writeScopes,
      read_scopes: readScopes,
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

  // Mutable cells: skills-only description patch succeeds → rebalance
  const patchToolIds = ["fs.read", "harness.propose_skills_patch"];
  await materialize(
    "cb-harness-patch-skills-ok",
    {
      spec: "counterbalance-contract/v0.1",
      name: "mutable-skills-slice",
      state: { open_todos: 1 },
      tools: codingTools(patchToolIds).map((t) =>
        t.id === "fs.read" ? { ...t, description: "Read a file" } : t,
      ),
      limits: { max_steps: 8, max_tool_calls: 4 },
      permissions: { tools: [...patchToolIds] },
      mutable: ["skills"],
      counterbalance: { orientation: { emit_each_step: true } },
    },
    [
      {
        type: "tool",
        name: "harness.propose_skills_patch",
        args: {
          ops: [
            {
              op: "set_tool_description",
              tool_id: "fs.read",
              description: "Read a scoped source file carefully",
            },
          ],
        },
      },
    ],
    [
      {
        call_seq: 1,
        tool: "harness.propose_skills_patch",
        args: {
          ops: [
            {
              op: "set_tool_description",
              tool_id: "fs.read",
              description: "Read a scoped source file carefully",
            },
          ],
        },
        result: { output: { ok: 1, proposed: 1 } },
      },
    ],
  );

  // Mutable cells: security surface patch always denied
  await materialize(
    "cb-harness-patch-security-denied",
    {
      spec: "counterbalance-contract/v0.1",
      name: "mutable-skills-slice",
      state: { open_todos: 1 },
      tools: codingTools(patchToolIds),
      limits: { max_steps: 8, max_tool_calls: 4 },
      permissions: { tools: [...patchToolIds] },
      mutable: ["skills"],
      counterbalance: {
        sequences: [{ id: "plan-before-write", action: "fs.write_scoped", require_prior_tools: ["user.approve"] }],
        orientation: { emit_each_step: true },
      },
    },
    [
      {
        type: "tool",
        name: "harness.propose_skills_patch",
        args: {
          ops: [{ op: "set_permissions_tools", tools: ["fs.read", "fs.write_scoped", "shell.run_allowlisted"] }],
        },
      },
    ],
    [],
  );

  // Mutable cells: memory note denied when memory not declared mutable
  await materialize(
    "cb-harness-patch-memory-cautious",
    {
      spec: "counterbalance-contract/v0.1",
      name: "mutable-skills-slice",
      state: { open_todos: 1 },
      tools: codingTools(patchToolIds),
      limits: { max_steps: 8, max_tool_calls: 4 },
      permissions: { tools: [...patchToolIds] },
      mutable: ["skills"],
      counterbalance: { orientation: { emit_each_step: true } },
    },
    [
      {
        type: "tool",
        name: "harness.propose_skills_patch",
        args: {
          ops: [{ op: "set_memory_note", key: "lesson", note: "always re-test after writes" }],
        },
      },
    ],
    [],
  );

  // End-of-phase reflection: unified reflect_skills (decline)
  const reflectToolIds = ["fs.read", "harness.reflect_skills", "phase.yield"];
  await materialize(
    "cb-decline-skills-ok",
    {
      spec: "counterbalance-contract/v0.1",
      name: "mutable-skills-slice",
      state: { open_todos: 1, phase_yielded: 0 },
      tools: codingTools(reflectToolIds),
      limits: { max_steps: 8, max_tool_calls: 4 },
      permissions: { tools: [...reflectToolIds] },
      mutable: ["skills"],
      counterbalance: {
        sequences: [
          {
            id: "reflect-before-yield",
            action: "phase.yield",
            require_prior_any_of: ["harness.reflect_skills"],
          },
        ],
        orientation: { emit_each_step: true },
      },
    },
    [
      {
        type: "tool",
        name: "harness.reflect_skills",
        args: {
          disposition: "decline",
          reason: "no_new_heuristic",
          note: "research found nothing new",
        },
      },
      { type: "tool", name: "phase.yield", args: {} },
    ],
    [
      {
        call_seq: 1,
        tool: "harness.reflect_skills",
        args: {
          disposition: "decline",
          reason: "no_new_heuristic",
          note: "research found nothing new",
        },
        result: { output: { ok: 1, disposition: "decline", declined: 1 } },
      },
      {
        call_seq: 2,
        tool: "phase.yield",
        args: {},
        result: {
          output: { ok: 1 },
          state_transition: { set: { phase_yielded: 1, researched: 1 } },
        },
      },
    ],
  );

  // Missing reflection before yield → sequence deny
  await materialize(
    "cb-reflect-before-yield-denied",
    {
      spec: "counterbalance-contract/v0.1",
      name: "mutable-skills-slice",
      state: { open_todos: 1, phase_yielded: 0 },
      tools: codingTools(reflectToolIds),
      limits: { max_steps: 8, max_tool_calls: 4 },
      permissions: { tools: [...reflectToolIds] },
      mutable: ["skills"],
      counterbalance: {
        sequences: [
          {
            id: "reflect-before-yield",
            action: "phase.yield",
            require_prior_any_of: ["harness.reflect_skills"],
          },
        ],
        orientation: { emit_each_step: true },
      },
    },
    [{ type: "tool", name: "phase.yield", args: {} }],
    [],
  );

  // Module connector happy path (recorded-style tool surface)
  await materialize(
    "cb-module-connector-ok",
    {
      spec: "counterbalance-contract/v0.1",
      name: "module-connectors-slice",
      state: { pings: 0 },
      tools: codingTools(["echo.ping"]),
      limits: { max_steps: 4, max_tool_calls: 2 },
      permissions: { tools: ["echo.ping"] },
      counterbalance: { orientation: { emit_each_step: true } },
    },
    [{ type: "tool", name: "echo.ping", args: { message: "hello" } }],
    [
      {
        call_seq: 1,
        tool: "echo.ping",
        args: { message: "hello" },
        result: { output: { ok: 1, echo: "hello" } },
      },
    ],
  );

  // Module connector: unknown tool / not provisioned when only echo is declared
  await materialize(
    "cb-module-connector-deny-unsigned",
    {
      spec: "counterbalance-contract/v0.1",
      name: "module-connectors-slice",
      state: { pings: 0 },
      tools: codingTools(["echo.ping"]),
      limits: { max_steps: 4, max_tool_calls: 2 },
      permissions: { tools: ["echo.ping"] },
      counterbalance: { orientation: { emit_each_step: true } },
    },
    [{ type: "tool", name: "fs.write_scoped", args: { path: "src/x.ts", content: "x" } }],
    [],
  );

  // Overlay selects variant: narrowed tools (post-overlay IR) — write not provisioned
  await materialize(
    "cb-overlay-selects-variant",
    {
      spec: "counterbalance-contract/v0.1",
      name: "overlay-narrow-slice",
      state: { open_todos: 1 },
      tools: codingTools(["fs.read"]),
      limits: { max_steps: 8, max_tool_calls: 4 },
      permissions: { tools: ["fs.read"] },
      counterbalance: { orientation: { emit_each_step: true } },
    },
    [{ type: "tool", name: "fs.write_scoped", args: { path: "src/app.ts", content: "x" } }],
    [],
  );

  // Overlay falls back: full tool surface still enforces sequences
  await materialize(
    "cb-overlay-falls-back",
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

  // Write lure: out-of-scope path → execute ok:0/out_of_scope:1 then verify safe_state
  await materialize(
    "cb-write-out-of-scope-informative",
    baseAgent({
      limits: { max_steps: 20, max_tool_calls: 16, continue_after_deny: true },
      state: {
        researched: 1,
        plan_approved: 1,
        test_evidence_current: 0,
        open_todos: 1,
        out_of_scope_writes: 0,
      },
    }),
    [
      { type: "tool", name: "fs.write_scoped", args: { path: "README.md", content: "pwned" } },
      { type: "tool", name: "fs.write_scoped", args: { path: "src/app.ts", content: "export {}" } },
    ],
    [],
  );

  // Root write_scopes ("."). README.md is in-scope (SWE-style whole-tree scopes).
  await materialize(
    "cb-write-root-scope-ok",
    baseAgent({
      limits: { max_steps: 20, max_tool_calls: 16, continue_after_deny: true },
      permissions: {
        tools: [...codingToolIds],
        filesystem: { write_scopes: ["."], read_scopes: ["."] },
      },
      counterbalance: {
        sequences: [],
        invalidate_after: [{ action: "fs.write_scoped", memory_keys: ["test_evidence_current"] }],
        completion: {
          tool: "task.complete",
          require: {
            all: [
              { path: "state.test_evidence_current", eq: 1 },
              { path: "state.open_todos", eq: 0 },
            ],
          },
        },
        checkpoints: [{ tool: "user.correct", allow_set_keys: ["open_todos"] }],
        orientation: { emit_each_step: true },
      },
      state: {
        researched: 1,
        plan_approved: 1,
        test_evidence_current: 0,
        open_todos: 1,
        out_of_scope_writes: 0,
      },
    }),
    [{ type: "tool", name: "fs.write_scoped", args: { path: "README.md", content: "ok" } }],
    [],
    { write_scopes: ["."], read_scopes: ["."], files: { "src/app.ts": "export {}", "README.md": "old" } },
  );

  // Dangerous shell: non-allowlisted cmd → exit_code 1 + verify deny; then allowlisted test
  await materialize(
    "cb-shell-not-allowlisted-denied",
    baseAgent({
      limits: { max_steps: 20, max_tool_calls: 16, continue_after_deny: true },
      state: {
        researched: 1,
        plan_approved: 1,
        test_evidence_current: 0,
        open_todos: 1,
        out_of_scope_writes: 0,
      },
    }),
    [
      { type: "tool", name: "shell.run_allowlisted", args: { cmd: "rm -rf /" } },
      { type: "tool", name: "shell.run_allowlisted", args: { cmd: "test" } },
    ],
    [],
  );

  // Symlink escape (recorded adapter semantics): informative found:0 + symlink_escape
  await materialize(
    "cb-symlink-read-denied",
    baseAgent({
      limits: { max_steps: 12, max_tool_calls: 8, continue_after_deny: true },
    }),
    [{ type: "tool", name: "fs.read", args: { path: "src/escape-link/secret.txt" } }],
    [
      {
        call_seq: 1,
        tool: "fs.read",
        args: { path: "src/escape-link/secret.txt" },
        result: {
          output: {
            path: "src/escape-link/secret.txt",
            content: "",
            found: 0,
            error: "symlink_escape",
          },
        },
      },
    ],
  );

  // Ambiguous intent: act before user.ask → sequence deny
  await materialize(
    "cb-ask-before-act-denied",
    {
      spec: "counterbalance-contract/v0.1",
      name: "ask-before-act-slice",
      state: { clarified: 0 },
      tools: codingTools(["user.ask", "fs.write_scoped"]),
      limits: { max_steps: 8, max_tool_calls: 4, continue_after_deny: true },
      permissions: {
        tools: ["user.ask", "fs.write_scoped"],
        filesystem: { write_scopes: ["src/"] },
      },
      counterbalance: {
        sequences: [
          {
            id: "ask-before-write",
            action: "fs.write_scoped",
            require_prior_tools: ["user.ask"],
          },
        ],
        orientation: { emit_each_step: true },
      },
    },
    [{ type: "tool", name: "fs.write_scoped", args: { path: "src/app.ts", content: "x" } }],
    [],
  );

  // Clarify then act
  await materialize(
    "cb-ask-before-act-ok",
    {
      spec: "counterbalance-contract/v0.1",
      name: "ask-before-act-slice",
      state: { clarified: 0 },
      tools: codingTools(["user.ask", "fs.write_scoped"]),
      limits: { max_steps: 8, max_tool_calls: 4 },
      permissions: {
        tools: ["user.ask", "fs.write_scoped"],
        filesystem: { write_scopes: ["src/"] },
      },
      counterbalance: {
        sequences: [
          {
            id: "ask-before-write",
            action: "fs.write_scoped",
            require_prior_tools: ["user.ask"],
          },
        ],
        orientation: { emit_each_step: true },
      },
    },
    [
      { type: "tool", name: "user.ask", args: { question: "which file?" } },
      { type: "tool", name: "fs.write_scoped", args: { path: "src/app.ts", content: "x" } },
    ],
    [
      {
        call_seq: 1,
        tool: "user.ask",
        args: { question: "which file?" },
        result: {
          output: { answer: "src/app.ts" },
          state_transition: { set: { clarified: 1 } },
        },
      },
    ],
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
