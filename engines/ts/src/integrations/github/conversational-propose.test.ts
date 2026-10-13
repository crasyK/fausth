import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createConversationalPropose } from "./conversational-propose.js";
import type { Event } from "../../types.js";
import type { ChatMessage, ModelPort, ModelProposal } from "../../model/port.js";
import { ModelInfraError } from "../../model/errors.js";
import type { FaustRuntime } from "../../runtime.js";

function mockAdapter(queue: ModelProposal[]): ModelPort & { calls: number } {
  let i = 0;
  return {
    lastModelUsed: "mock",
    calls: 0,
    async propose() {
      this.calls += 1;
      const next = queue[Math.min(i, queue.length - 1)]!;
      i += 1;
      return next;
    },
  };
}

function mockRuntime(): FaustRuntime {
  return { events: [] } as unknown as FaustRuntime;
}

describe("createConversationalPropose", () => {
  it("retries once on empty stop when tools are offered", async () => {
    const adapter = mockAdapter([
      { type: "stop", message: "thinking..." },
      {
        type: "tool",
        name: "fs.read",
        args: { path: "src/app.js" },
        tool_call_id: "c1",
        transport_name: "faust_tool_0001",
      },
    ]);
    const propose = createConversationalPropose({
      adapter,
      tools: [{ id: "fs.read", input: { type: "object" } }],
      system: "sys",
      user: "do it",
      getRuntime: mockRuntime,
      tool_choice: "required",
    });
    const out = await propose();
    assert.equal(adapter.calls, 2);
    assert.equal(out.type, "tool");
    if (out.type === "tool") assert.equal(out.name, "fs.read");
  });

  it("returns empty_proposal after two empty stops", async () => {
    const adapter = mockAdapter([
      { type: "stop", message: "nope" },
      { type: "stop", message: "still nope" },
    ]);
    const propose = createConversationalPropose({
      adapter,
      tools: [{ id: "fs.read", input: { type: "object" } }],
      system: "sys",
      user: "do it",
      getRuntime: mockRuntime,
    });
    const out = await propose();
    assert.equal(adapter.calls, 2);
    assert.equal(out.type, "invalid");
    if (out.type === "invalid") {
      assert.equal(out.reason, "empty_proposal");
      assert.match(out.raw ?? "", /still nope/);
    }
  });

  it("does not retry when no tools are offered", async () => {
    const adapter = mockAdapter([{ type: "stop", message: "done" }]);
    const propose = createConversationalPropose({
      adapter,
      tools: [],
      system: "sys",
      user: "hi",
      getRuntime: mockRuntime,
    });
    const out = await propose();
    assert.equal(adapter.calls, 1);
    assert.equal(out.type, "stop");
  });

  it("surfaces structured failure on authorize deny in tool result", async () => {
    let toolResult = "";
    let calls = 0;
    const adapter: ModelPort = {
      lastModelUsed: "mock",
      async propose(req) {
        calls += 1;
        const toolMsg = [...req.messages].reverse().find((m) => m.role === "tool");
        if (toolMsg && typeof toolMsg.content === "string") toolResult = toolMsg.content;
        if (calls === 1) {
          return {
            type: "tool",
            name: "task.complete",
            args: {},
            tool_call_id: "c1",
            transport_name: "faust_tool_0001",
          };
        }
        return { type: "stop", message: "ok" };
      },
    };
    const runtime = { events: [] as Event[] };
    const propose = createConversationalPropose({
      adapter,
      tools: [{ id: "task.complete", input: { type: "object" } }],
      system: "sys",
      user: "finish",
      getRuntime: () => runtime as unknown as FaustRuntime,
      tool_choice: "auto",
    });
    const first = await propose();
    assert.equal(first.type, "tool");
    runtime.events.push(
      {
        seq: 1,
        ts_logical: 1,
        stage: "orient",
        state_hash: "x",
        observation: { completion: { ready: 0 } },
      },
      {
        seq: 2,
        ts_logical: 2,
        stage: "authorize",
        state_hash: "x",
        verdict: "deny",
        reason: "completion_gate_failed",
        failure: {
          kind: "predicate",
          failed: [
            {
              path: "state.open_todos",
              current: 1,
              require: { eq: 0 },
              unblock: { tool: "user.correct", set_key: "open_todos", set_value: 0 },
            },
          ],
        },
        tool: "task.complete",
      },
    );
    await propose();
    assert.ok(toolResult, "expected tool result with deny failure");
    const parsed = JSON.parse(toolResult) as {
      failure?: { kind: string; failed?: { unblock?: { tool: string } }[] };
      hint?: string;
      error?: string;
    };
    assert.equal(parsed.error, "completion_gate_failed");
    assert.equal(parsed.failure?.kind, "predicate");
    assert.equal(parsed.failure?.failed?.[0]?.unblock?.tool, "user.correct");
    assert.match(parsed.hint ?? "", /user\.correct/);
  });
});

/** Every assistant tool_call id must be answered by a tool message before the next request. */
function assertTranscriptValid(messages: ChatMessage[]): void {
  const open = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      assert.equal(open.size, 0, "assistant turn while a tool call is unanswered");
      for (const tc of m.tool_calls) open.add(tc.id);
    } else if (m.role === "tool") {
      assert.ok(m.tool_call_id && open.has(m.tool_call_id), "tool message without a matching call");
      open.delete(m.tool_call_id!);
    } else {
      assert.equal(open.size, 0, `${m.role} message while a tool call is unanswered`);
    }
  }
  assert.equal(open.size, 0, "request sent with a dangling tool_call id");
}

describe("createConversationalPropose one-tool-per-step + provider fields (EDGE-13)", () => {
  function scriptedAdapter(queue: ModelProposal[]): ModelPort & { requests: ChatMessage[][] } {
    let i = 0;
    const requests: ChatMessage[][] = [];
    return {
      lastModelUsed: "m",
      requests,
      async propose(req) {
        requests.push(structuredClone(req.messages));
        const next = queue[Math.min(i, queue.length - 1)]!;
        i += 1;
        return next;
      },
    };
  }

  const multi: ModelProposal = {
    type: "invalid",
    reason: "multiple_tool_calls",
    raw: '[{"name":"fs.read"},{"name":"fs.list"}]',
    model: "m",
  };

  it("nudges for a single call after multiple_tool_calls and keeps the transcript valid", async () => {
    const adapter = scriptedAdapter([
      multi,
      { type: "tool", name: "fs.read", args: { path: "a" }, tool_call_id: "c1", transport_name: "faust_tool_0001", model: "m" },
      { type: "stop", message: "done", model: "m" },
    ]);
    const runtime = { events: [] as Event[] };
    const propose = createConversationalPropose({
      adapter,
      tools: [
        { id: "fs.read", input: { type: "object" } },
        { id: "fs.list", input: { type: "object" } },
      ],
      system: "sys",
      user: "go",
      getRuntime: () => runtime as unknown as FaustRuntime,
    });
    // The protocol failure reaches the runtime with its reason (never hidden by a retry).
    const first = await propose();
    assert.equal(first.type, "invalid");
    if (first.type === "invalid") assert.equal(first.reason, "multiple_tool_calls");
    assert.equal(adapter.requests.length, 1);
    const second = await propose();
    assert.equal(second.type, "tool");
    const retryReq = adapter.requests[1]!;
    const nudge = retryReq[retryReq.length - 1]!;
    assert.equal(nudge.role, "user");
    assert.match(String(nudge.content), /exactly one tool/i);
    // The multi-call turn is recorded as plain assistant text, never as tool_calls.
    assert.equal(retryReq[retryReq.length - 2]!.role, "assistant");
    assert.equal(retryReq[retryReq.length - 2]!.tool_calls, undefined);
    runtime.events.push({
      seq: 1,
      ts_logical: 1,
      stage: "execute",
      state_hash: "x",
      verdict: "allow",
      tool: "fs.read",
      result: { found: 1 },
    });
    await propose();
    for (const req of adapter.requests) assertTranscriptValid(req);
  });

  it("keeps a protocol reason that follows a nudged plain-text answer (not collapsed to empty_proposal)", async () => {
    const adapter = scriptedAdapter([{ type: "stop", message: "let me think", model: "m" }, multi]);
    const propose = createConversationalPropose({
      adapter,
      tools: [{ id: "fs.read", input: { type: "object" } }],
      system: "sys",
      user: "go",
      getRuntime: mockRuntime,
    });
    const out = await propose();
    assert.equal(out.type, "invalid");
    if (out.type === "invalid") assert.equal(out.reason, "multiple_tool_calls");
  });

  it("attaches preserved provider fields + model to the assistant turn they came from", async () => {
    const reasoning = [{ type: "reasoning.text", text: "why" }];
    const adapter = scriptedAdapter([
      {
        type: "tool",
        name: "fs.read",
        args: {},
        tool_call_id: "c1",
        transport_name: "faust_tool_0001",
        model: "m",
        provider_fields: { reasoning_details: reasoning },
      },
      { type: "stop", message: "done", model: "m" },
    ]);
    const runtime = { events: [] as Event[] };
    const propose = createConversationalPropose({
      adapter,
      tools: [{ id: "fs.read", input: { type: "object" } }],
      system: "sys",
      user: "go",
      getRuntime: () => runtime as unknown as FaustRuntime,
      tool_choice: "auto",
    });
    await propose();
    await propose();
    const second = adapter.requests[1]!;
    const assistant = second.find((m) => m.role === "assistant")!;
    assert.deepEqual(assistant.provider_fields, { reasoning_details: reasoning });
    assert.equal(assistant.model, "m");
    assertTranscriptValid(second);
  });

  it("propagates infra errors unchanged (never turned into a proposal)", async () => {
    const adapter: ModelPort = {
      lastModelUsed: "m",
      async propose() {
        throw new ModelInfraError("timeout", "model request timed out");
      },
    };
    const propose = createConversationalPropose({
      adapter,
      tools: [{ id: "fs.read", input: { type: "object" } }],
      system: "sys",
      user: "go",
      getRuntime: mockRuntime,
    });
    await assert.rejects(propose(), (e: unknown) => e instanceof ModelInfraError && e.kind === "timeout");
  });

  it("never drops a protocol reason behind a host retry (invalid then tool → the invalid is returned)", async () => {
    const bad: ModelProposal = { type: "invalid", reason: "invalid_tool_arguments_json", raw: "{not json", model: "m" };
    const adapter = scriptedAdapter([
      bad,
      { type: "tool", name: "fs.read", args: { path: "a" }, tool_call_id: "c1", transport_name: "faust_tool_0001", model: "m" },
    ]);
    const propose = createConversationalPropose({
      adapter,
      tools: [{ id: "fs.read", input: { type: "object" } }],
      system: "sys",
      user: "go",
      getRuntime: mockRuntime,
    });
    const out = await propose();
    assert.equal(out.type, "invalid");
    if (out.type === "invalid") assert.equal(out.reason, "invalid_tool_arguments_json");
    assert.equal(adapter.requests.length, 1, "no hidden second request in the same step");
  });
});
