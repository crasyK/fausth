import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isPreExecutionPolicyDeny,
  lastExitCode,
  parseArgs,
  permittedToolDefs,
  runCompleted,
  systemPromptFor,
} from "./cli-support.js";
import type { AgentIR, Event } from "./types.js";

describe("parseArgs (CORE-17)", () => {
  it("boolean flags never swallow the harness positional", () => {
    const r = parseArgs(["--expect-complete", "examples/x", "--dump", "out.jsonl"]);
    assert.deepEqual(r.positionals, ["examples/x"]);
    assert.equal(r.flags["expect-complete"], "true");
    assert.equal(r.flags.dump, "out.jsonl");
  });

  it("boolean flags accept an explicit literal", () => {
    assert.equal(parseArgs(["--expect-complete", "false", "dir"]).flags["expect-complete"], "false");
    assert.deepEqual(parseArgs(["--expect-complete", "false", "dir"]).positionals, ["dir"]);
    assert.equal(parseArgs(["--skip-fixtures", "1"]).flags["skip-fixtures"], "1");
  });

  it("supports --flag=value and value flags", () => {
    const r = parseArgs(["dir", "--max-steps=7", "--deployment", "d.yml", "--json"]);
    assert.deepEqual(r.positionals, ["dir"]);
    assert.equal(r.flags["max-steps"], "7");
    assert.equal(r.flags.deployment, "d.yml");
    assert.equal(r.flags.json, "true");
  });

  it("--allow-command repeats accumulate; --require-trusted is boolean", () => {
    const r = parseArgs(["--allow-command", "node", "--allow-command=python3", "--require-trusted", "bundle.json"]);
    assert.equal(r.flags["allow-command"], "node,python3");
    assert.equal(r.flags["require-trusted"], "true");
    assert.deepEqual(r.positionals, ["bundle.json"]);
  });

  it("a value flag at the end or before another flag is 'true', not the next flag", () => {
    const r = parseArgs(["--report", "--json"]);
    assert.equal(r.flags.report, "true");
    assert.equal(r.flags.json, "true");
  });
});

describe("host metrics (CORE-13, spec-v0.3 §15.3)", () => {
  const ev = (e: Partial<Event>): Event => ({ seq: 1, ts_logical: 1, state_hash: "h", stage: "record", ...e });

  it("counts only pre-execution policy denies", () => {
    assert.equal(isPreExecutionPolicyDeny(ev({ stage: "authorize", verdict: "deny", reason: "gate_denied" })), true);
    assert.equal(isPreExecutionPolicyDeny(ev({ stage: "validate", verdict: "deny", reason: "capability_missing" })), true);
    assert.equal(
      isPreExecutionPolicyDeny(ev({ stage: "authorize", verdict: "deny", reason: "sequence_requirement_failed" })),
      true,
    );
    // telemetry / infra / post-execution are not catches
    assert.equal(isPreExecutionPolicyDeny(ev({ stage: "record", verdict: "allow", reason: "memory_stale" })), false);
    assert.equal(isPreExecutionPolicyDeny(ev({ stage: "execute", verdict: "deny", reason: "tool_execution_failed" })), false);
    assert.equal(isPreExecutionPolicyDeny(ev({ stage: "authorize", verdict: "deny", reason: "limit_exceeded" })), false);
    assert.equal(isPreExecutionPolicyDeny(ev({ stage: "verify", verdict: "deny", reason: "verify_absence_failed" })), false);
    assert.equal(
      isPreExecutionPolicyDeny(
        ev({ stage: "validate", verdict: "deny", reason: "capability_missing", failure: { kind: "channel_unbound", channel: "user" } }),
      ),
      false,
      "an unbound user channel is a host gap, not a caught unsafe action",
    );
  });

  it("completion is the record run_complete of the top-level reaction (D8)", () => {
    assert.equal(runCompleted([ev({ stage: "execute", verdict: "allow", tool: "task.complete" })]), false);
    assert.equal(runCompleted([ev({ stage: "record", reason: "run_complete", depth: 1 })]), false);
    assert.equal(runCompleted([ev({ stage: "record", reason: "run_complete" })]), true);
  });

  it("lastExitCode reads only successful top-level executes", () => {
    assert.equal(lastExitCode([ev({ stage: "execute", verdict: "allow", result: { exit_code: 3 } })]), 3);
    assert.equal(lastExitCode([ev({ stage: "execute", verdict: "deny", result: { exit_code: 3 } })]), null);
  });
});

describe("host prompts and tool offer (D11, spec-v0.3 §15.3)", () => {
  const agent: AgentIR = {
    spec: "counterbalance-contract/v0.3",
    name: "plan",
    state: {},
    tools: [{ id: "a" }, { id: "b" }],
    permissions: { tools: ["a"] },
    instinct_text: "Approve first.",
  };

  it("builds the system context only from harness-declared text", () => {
    assert.equal(systemPromptFor(agent), "You are plan.\n\nApprove first.");
    assert.equal(systemPromptFor(agent, "Short answers."), "You are plan.\n\nApprove first.\n\nShort answers.");
  });

  it("offers exactly the permitted set", () => {
    assert.deepEqual(permittedToolDefs(agent).map((t) => t.id), ["a"]);
    assert.deepEqual(permittedToolDefs({ ...agent, permissions: { tools: [] } }), []);
  });
});
