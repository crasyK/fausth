import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenAICompatibleAdapter } from "./openai-compatible.js";
import type { ProviderCapabilities } from "../capabilities.js";

function mockFetchSequence(
  responses: Array<{ status: number; body: unknown } | { status: number; text: string }>,
): { calls: Array<{ url: string; init: RequestInit }>; restore: () => void } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    if ("text" in next && typeof next.text === "string" && !("body" in next)) {
      return new Response(next.text, { status: next.status });
    }
    return new Response(JSON.stringify((next as { body: unknown }).body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const caps: ProviderCapabilities = {
  chat_completions: true,
  native_tools: true,
  parallel_tools: "unknown",
  structured_output: true,
  streaming: "unknown",
  reasoning_details: "unknown",
  max_tokens_field: "max_tokens",
  tool_choice: true,
};

describe("OpenAICompatibleAdapter", () => {
  it("maps content without tool_calls to stop", async () => {
    const { restore } = mockFetchSequence([
      {
        status: 200,
        body: {
          choices: [{ message: { content: "hello", tool_calls: undefined } }],
        },
      },
    ]);
    try {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: "https://example.test/v1",
        apiKey: "k",
        models: ["m"],
        capabilities: caps,
      });
      const out = await adapter.propose({
        messages: [{ role: "user", content: "hi" }],
        tools: [{ id: "fs.read", input: { type: "object" } }],
        tool_choice: "auto",
      });
      assert.equal(out.type, "stop");
      if (out.type === "stop") assert.equal(out.message, "hello");
    } finally {
      restore();
    }
  });

  it("sends tool_choice required when requested", async () => {
    const { calls, restore } = mockFetchSequence([
      {
        status: 200,
        body: {
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "c1",
                    type: "function",
                    function: { name: "faust_tool_0001", arguments: "{\"path\":\"a\"}" },
                  },
                ],
              },
            },
          ],
        },
      },
    ]);
    try {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: "https://example.test/v1",
        apiKey: "k",
        models: ["m"],
        capabilities: caps,
      });
      const out = await adapter.propose({
        messages: [{ role: "user", content: "hi" }],
        tools: [{ id: "fs.read", input: { type: "object", properties: { path: { type: "string" } } } }],
        tool_choice: "required",
      });
      assert.equal(out.type, "tool");
      const body = JSON.parse(String(calls[0]!.init.body));
      assert.equal(body.tool_choice, "required");
    } finally {
      restore();
    }
  });

  it("returns invalid for bad tool argument JSON", async () => {
    const { restore } = mockFetchSequence([
      {
        status: 200,
        body: {
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "c1",
                    type: "function",
                    function: { name: "faust_tool_0001", arguments: "{not-json" },
                  },
                ],
              },
            },
          ],
        },
      },
    ]);
    try {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: "https://example.test/v1",
        apiKey: "k",
        models: ["m"],
        capabilities: caps,
      });
      const out = await adapter.propose({
        messages: [{ role: "user", content: "hi" }],
        tools: [{ id: "fs.read", input: { type: "object" } }],
        tool_choice: "required",
      });
      assert.equal(out.type, "invalid");
      if (out.type === "invalid") assert.equal(out.reason, "invalid_tool_arguments_json");
    } finally {
      restore();
    }
  });

  it("falls back to auto when required is rejected", async () => {
    const { calls, restore } = mockFetchSequence([
      { status: 400, text: "unsupported tool_choice required" },
      {
        status: 200,
        body: {
          choices: [{ message: { content: "ok" } }],
        },
      },
    ]);
    try {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: "https://example.test/v1",
        apiKey: "k",
        models: ["m"],
        capabilities: caps,
      });
      const out = await adapter.propose({
        messages: [{ role: "user", content: "hi" }],
        tools: [{ id: "fs.read", input: { type: "object" } }],
        tool_choice: "required",
      });
      assert.equal(out.type, "stop");
      assert.equal(calls.length, 2);
      assert.equal(JSON.parse(String(calls[0]!.init.body)).tool_choice, "required");
      assert.equal(JSON.parse(String(calls[1]!.init.body)).tool_choice, "auto");
    } finally {
      restore();
    }
  });

  it("retries with auto when required returns no tool_calls", async () => {
    const { calls, restore } = mockFetchSequence([
      {
        status: 200,
        body: {
          choices: [
            {
              finish_reason: "tool_calls",
              message: { content: "", tool_calls: [] },
            },
          ],
        },
      },
      {
        status: 200,
        body: {
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "c1",
                    type: "function",
                    function: { name: "faust_tool_0001", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        },
      },
    ]);
    try {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: "https://example.test/v1",
        apiKey: "k",
        models: ["m"],
        capabilities: caps,
      });
      const out = await adapter.propose({
        messages: [{ role: "user", content: "hi" }],
        tools: [{ id: "fs.read", input: { type: "object" } }],
        tool_choice: "required",
      });
      assert.equal(out.type, "tool");
      if (out.type === "tool") assert.equal(out.name, "fs.read");
      assert.equal(calls.length, 2);
      assert.equal(JSON.parse(String(calls[0]!.init.body)).tool_choice, "required");
      assert.equal(JSON.parse(String(calls[1]!.init.body)).tool_choice, "auto");
    } finally {
      restore();
    }
  });
});
