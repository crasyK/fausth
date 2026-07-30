import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createConversationalPropose } from "./conversational-propose.js";
import type { Event } from "../../types.js";
import type { ModelPort, ModelProposal } from "../../model/port.js";
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
