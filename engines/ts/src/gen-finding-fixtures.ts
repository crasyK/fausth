/**
 * Generate Track A finding.submit evidence/absence/schema fixtures.
 * Hand-review expected.jsonl before treating as normative.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FaustRuntime, eventsToJsonl } from "./runtime.js";
import { toCanonicalIrJson } from "./load.js";
import type { AgentIR, ModelProposal, RecordedToolCall, ToolHandler } from "./types.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const findingInput = {
  type: "object",
  required: ["category", "severity", "path", "evidence", "recommendation"],
  additionalProperties: false,
  properties: {
    category: {
      type: "string",
      enum: [
        "incomplete_submission",
        "scope_violation",
        "missing_instructions",
        "potential_secret",
        "safety_concern",
        "contradiction",
        "human_review",
      ],
    },
    severity: { type: "string", enum: ["info", "warning", "blocking"] },
    path: { type: "string" },
    line_start: { type: "integer", minimum: 1 },
    evidence: { type: "string", minLength: 1 },
    recommendation: { type: "string", minLength: 1 },
  },
} as const;

const findingOutput = {
  type: "object",
  required: ["accepted", "verified"],
  additionalProperties: false,
  properties: {
    accepted: { type: "integer" },
    verified: { type: "integer" },
    reason: { type: "string" },
    out_of_scope: { type: "integer" },
  },
} as const;

function findingAgent(verify: AgentIR["tools"][0]["verify"]): AgentIR {
  return {
    spec: "counterbalance-contract/v0.1",
    name: "finding-review-micro",
    state: { findings_submitted: 0 },
    fallback_state: { findings_submitted: 0 },
    limits: { max_steps: 6, max_tool_calls: 4 },
    tools: [
      {
        id: "finding.submit",
        description: "Submit one evidence-bound finding",
        input: findingInput as unknown as AgentIR["tools"][0]["input"],
        output: findingOutput as unknown as AgentIR["tools"][0]["output"],
        verify,
      },
    ],
    gates: [
      {
        id: "only-finding",
        require: { path: "action.name", eq: "finding.submit" },
        otherwise: "deny",
      },
    ],
    permissions: { tools: ["finding.submit"] },
  };
}

const evidenceVerify = [
  {
    kind: "evidence" as const,
    require: { path: "result.verified", eq: 1 },
    otherwise: "deny" as const,
  },
];

const absenceVerify = [
  {
    kind: "absence" as const,
    require: { path: "result.out_of_scope", eq: 0 },
    otherwise: "deny" as const,
  },
];

const goodArgs = {
  category: "missing_instructions",
  severity: "warning",
  path: "projects/demo/README.md",
  line_start: 1,
  evidence: "## Setup",
  recommendation: "Add a Demo section",
};

async function writeFixture(
  name: string,
  agent: AgentIR,
  proposals: ModelProposal[],
  toolsQueue?: RecordedToolCall[],
) {
  const dir = join(root, "conformance/fixtures", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.json"), toCanonicalIrJson(agent));
  writeFileSync(
    join(dir, "model.jsonl"),
    proposals.map((p) => JSON.stringify(p)).join("\n") + "\n",
  );
  if (toolsQueue) {
    writeFileSync(
      join(dir, "tools.jsonl"),
      toolsQueue.map((t) => JSON.stringify(t)).join("\n") + "\n",
    );
  }
  const stub: Record<string, ToolHandler> = {
    "finding.submit": () => {
      throw new Error("finding.submit must use recorded results in Track A");
    },
  };
  let pi = 0;
  const runtime = new FaustRuntime({
    agent,
    propose: async () => (pi >= proposals.length ? { type: "stop" } : proposals[pi++]!),
    tools: stub,
    recordedToolResults: toolsQueue,
    allowJudge: false,
  });
  await runtime.runLoop();
  writeFileSync(join(dir, "expected.jsonl"), eventsToJsonl(runtime.events));
  console.log("wrote", name, runtime.events.length, "events");
}

async function main() {
  await writeFixture(
    "finding-evidence-ok",
    findingAgent(evidenceVerify),
    [{ type: "tool", name: "finding.submit", args: goodArgs }, { type: "stop" }],
    [
      {
        call_seq: 1,
        tool: "finding.submit",
        args: goodArgs,
        result: {
          output: { accepted: 1, verified: 1 },
          state_transition: { set: { findings_submitted: 1 } },
        },
      },
    ],
  );

  await writeFixture(
    "finding-evidence-bad-path",
    findingAgent(evidenceVerify),
    [
      {
        type: "tool",
        name: "finding.submit",
        args: { ...goodArgs, path: "projects/missing/README.md" },
      },
    ],
    [
      {
        call_seq: 1,
        tool: "finding.submit",
        args: { ...goodArgs, path: "projects/missing/README.md" },
        result: {
          output: { accepted: 0, verified: 0, reason: "path_not_in_packet" },
        },
      },
    ],
  );

  await writeFixture(
    "finding-evidence-bad-snippet",
    findingAgent(evidenceVerify),
    [
      {
        type: "tool",
        name: "finding.submit",
        args: { ...goodArgs, evidence: "THIS_SNIPPET_IS_ABSENT" },
      },
    ],
    [
      {
        call_seq: 1,
        tool: "finding.submit",
        args: { ...goodArgs, evidence: "THIS_SNIPPET_IS_ABSENT" },
        result: {
          output: { accepted: 0, verified: 0, reason: "evidence_not_found" },
        },
      },
    ],
  );

  const oosArgs = {
    ...goodArgs,
    path: "../secrets/key.txt",
  };
  await writeFixture(
    "finding-absence-oos-path",
    findingAgent(absenceVerify),
    [{ type: "tool", name: "finding.submit", args: oosArgs }],
    [
      {
        call_seq: 1,
        tool: "finding.submit",
        args: oosArgs,
        result: {
          output: { accepted: 0, verified: 0, out_of_scope: 1, reason: "path_out_of_scope" },
        },
      },
    ],
  );

  await writeFixture(
    "finding-schema-invalid",
    findingAgent(evidenceVerify),
    [
      {
        type: "tool",
        name: "finding.submit",
        args: {
          category: "not_a_real_category",
          severity: "warning",
          path: "projects/demo/README.md",
          evidence: "## Setup",
          recommendation: "fix",
        },
      },
    ],
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
