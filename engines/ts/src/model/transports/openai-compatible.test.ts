import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenAICompatibleAdapter, wireMessages } from "./openai-compatible.js";
import {
  boundProviderText,
  isModelInfraError,
  isModelRequestError,
  ModelInfraError,
  modelTransportErrorJson,
} from "../errors.js";
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

// ---------------------------------------------------------------------------
// EDGE-13 regression tests: timeouts, infra taxonomy, one tool per step,
// argument shape, provider-field placement.
// ---------------------------------------------------------------------------

type MockStep =
  | { status: number; body: unknown; headers?: Record<string, string> }
  | { status: number; text: string; headers?: Record<string, string> }
  | { hang: true }
  | { throws: Error };

function mockFetchSteps(steps: MockStep[]): {
  calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }>;
  restore: () => void;
} {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  let i = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      init: init ?? {},
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    const step = steps[Math.min(i, steps.length - 1)]!;
    i += 1;
    if ("hang" in step) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // never settles without an AbortSignal
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    }
    if ("throws" in step) throw step.throws;
    if ("text" in step) {
      return new Response(step.text, { status: step.status, headers: step.headers });
    }
    return new Response(JSON.stringify(step.body), {
      status: step.status,
      headers: { "Content-Type": "application/json", ...(step.headers ?? {}) },
    });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function toolCallMsg(calls: Array<{ id: string; name: string; args: string }>, extra: Record<string, unknown> = {}) {
  return {
    choices: [
      {
        message: {
          content: "",
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.args },
          })),
          ...extra,
        },
      },
    ],
  };
}

function adapterFor(models: string[], extra: Partial<ConstructorParameters<typeof OpenAICompatibleAdapter>[0]> = {}) {
  return new OpenAICompatibleAdapter({
    baseUrl: "https://example.test/v1",
    apiKey: "test-key-not-real",
    models,
    capabilities: caps,
    retryBaseMs: 0,
    ...extra,
  });
}

const oneTool = [{ id: "fs.read", input: { type: "object", properties: { path: { type: "string" } } } }];
const twoTools = [
  { id: "fs.read", input: { type: "object" } },
  { id: "fs.list", input: { type: "object" } },
];

describe("OpenAICompatibleAdapter infra taxonomy (EDGE-13)", () => {
  it("times out via AbortSignal and throws ModelInfraError(timeout)", { timeout: 5000 }, async () => {
    const { calls, restore } = mockFetchSteps([{ hang: true }]);
    try {
      const adapter = adapterFor(["m"], { timeoutMs: 25, maxAttempts: 2 });
      await assert.rejects(
        adapter.propose({ messages: [{ role: "user", content: "hi" }], tools: [] }),
        (e: unknown) => {
          assert.ok(isModelInfraError(e));
          assert.equal((e as ModelInfraError).kind, "timeout");
          return true;
        },
      );
      assert.equal(calls.length, 2);
      for (const c of calls) assert.ok(c.init.signal instanceof AbortSignal);
    } finally {
      restore();
    }
  });

  it("all-429 throws a typed rate_limit error (not 'undefined') with legacy prefix + code", async () => {
    const { calls, restore } = mockFetchSteps([{ status: 429, text: "slow down" }]);
    try {
      const adapter = adapterFor(["a", "b"], { maxAttempts: 2 });
      await assert.rejects(
        adapter.propose({ messages: [{ role: "user", content: "hi" }], tools: [] }),
        (e: unknown) => {
          assert.ok(e instanceof ModelInfraError);
          assert.equal(e.kind, "rate_limit");
          assert.equal(e.status, 429);
          assert.equal(e.code, 2);
          assert.match(e.message, /^RATE_LIMIT/);
          assert.notEqual(e.message, "undefined");
          return true;
        },
      );
      // 2 attempts per model, both models tried
      assert.equal(calls.length, 4);
      assert.deepEqual(
        calls.map((c) => c.body.model),
        ["a", "a", "b", "b"],
      );
    } finally {
      restore();
    }
  });

  it("daily quota 429 stops immediately without model fallback", async () => {
    const { calls, restore } = mockFetchSteps([
      { status: 429, text: "Rate limit exceeded: free-models-per-day" },
    ]);
    try {
      const adapter = adapterFor(["a", "b"]);
      await assert.rejects(
        adapter.propose({ messages: [{ role: "user", content: "hi" }], tools: [] }),
        (e: unknown) => isModelInfraError(e) && e.kind === "rate_limit",
      );
      assert.equal(calls.length, 1);
    } finally {
      restore();
    }
  });

  it("404 falls back to the next model; proposal records the model", async () => {
    const { calls, restore } = mockFetchSteps([
      { status: 404, text: "no such model" },
      { status: 200, body: { choices: [{ message: { content: "ok" } }] } },
    ]);
    try {
      const adapter = adapterFor(["gone", "ok-model"]);
      const out = await adapter.propose({ messages: [{ role: "user", content: "hi" }], tools: [] });
      assert.equal(out.type, "stop");
      assert.equal(out.model, "ok-model");
      assert.equal(adapter.lastModelUsed, "ok-model");
      assert.equal(calls.length, 2);
    } finally {
      restore();
    }
  });

  it("401 is an auth infra error without retries or fallback", async () => {
    const { calls, restore } = mockFetchSteps([{ status: 401, text: "invalid api key" }]);
    try {
      const adapter = adapterFor(["a", "b"]);
      await assert.rejects(
        adapter.propose({ messages: [{ role: "user", content: "hi" }], tools: [] }),
        (e: unknown) => isModelInfraError(e) && e.kind === "auth" && e.status === 401,
      );
      assert.equal(calls.length, 1);
    } finally {
      restore();
    }
  });

  it("5xx is retried, then succeeds; persistent 5xx is server_error", async () => {
    const ok = mockFetchSteps([
      { status: 503, text: "upstream down" },
      { status: 200, body: { choices: [{ message: { content: "fine" } }] } },
    ]);
    try {
      const out = await adapterFor(["m"]).propose({ messages: [{ role: "user", content: "hi" }], tools: [] });
      assert.equal(out.type, "stop");
      assert.equal(ok.calls.length, 2);
    } finally {
      ok.restore();
    }
    const bad = mockFetchSteps([{ status: 500, text: "boom" }]);
    try {
      await assert.rejects(
        adapterFor(["m"], { maxAttempts: 3 }).propose({ messages: [{ role: "user", content: "hi" }], tools: [] }),
        (e: unknown) => isModelInfraError(e) && e.kind === "server_error",
      );
      assert.equal(bad.calls.length, 3);
    } finally {
      bad.restore();
    }
  });

  it("network failures are network infra errors", async () => {
    const { restore } = mockFetchSteps([{ throws: new TypeError("fetch failed") }]);
    try {
      await assert.rejects(
        adapterFor(["m"], { maxAttempts: 2 }).propose({ messages: [{ role: "user", content: "hi" }], tools: [] }),
        (e: unknown) => isModelInfraError(e) && e.kind === "network",
      );
    } finally {
      restore();
    }
  });

  it("HTTP 400 for a request the harness built is request_rejected — neither infra nor a model failure", async () => {
    const { calls, restore } = mockFetchSteps([{ status: 400, text: "context length exceeded: 140000 > 131072" }]);
    try {
      await assert.rejects(
        adapterFor(["m"]).propose({ messages: [{ role: "user", content: "hi" }], tools: [] }),
        (e: unknown) =>
          isModelRequestError(e) &&
          !isModelInfraError(e) &&
          e.kind === "request_rejected" &&
          e.infra === false &&
          e.status === 400 &&
          e.model === "m" &&
          e.attempts === 1 &&
          e.total_attempts === 1,
      );
      assert.equal(calls.length, 1, "a rejected request is not retried");
    } finally {
      restore();
    }
  });

  it("413/422 are request_rejected too; another model may still accept the request", async () => {
    const { calls, restore } = mockFetchSteps([
      { status: 413, text: "payload too large" },
      { status: 200, body: { id: "cmpl-b", choices: [{ message: { content: "fits" } }] } },
    ]);
    try {
      const out = await adapterFor(["small", "large"]).propose({ messages: [{ role: "user", content: "hi" }], tools: [] });
      assert.equal(out.type, "stop");
      assert.equal(out.model, "large");
      assert.equal(calls.length, 2);
    } finally {
      restore();
    }
  });

  it("KIT '400 ServiceUnavailable' (gateway overload) stays infra: retried, then server_error", async () => {
    const overload = {
      status: 400,
      text: '{"error":{"message":"litellm.ServiceUnavailableError: 400 ServiceUnavailable - model overloaded","code":"400"}}',
    };
    const recover = mockFetchSteps([overload, { status: 200, body: { id: "cmpl-ok", choices: [{ message: { content: "ok" } }] } }]);
    try {
      const out = await adapterFor(["m"]).propose({ messages: [{ role: "user", content: "hi" }], tools: [] });
      assert.equal(out.type, "stop");
      assert.equal(recover.calls.length, 2, "transient 400 is retried");
    } finally {
      recover.restore();
    }
    const down = mockFetchSteps([overload]);
    try {
      await assert.rejects(
        adapterFor(["m"], { maxAttempts: 3 }).propose({ messages: [{ role: "user", content: "hi" }], tools: [] }),
        (e: unknown) => isModelInfraError(e) && e.kind === "server_error" && e.status === 400 && e.attempts === 3,
      );
    } finally {
      down.restore();
    }
  });

  it("a provider error with code 400 in a 2xx body is request_rejected; a transient one is infra", async () => {
    const rejected = mockFetchSteps([{ status: 200, body: { error: { code: 400, message: "tools[0].parameters is invalid" } } }]);
    try {
      await assert.rejects(
        adapterFor(["m"]).propose({ messages: [{ role: "user", content: "hi" }], tools: [] }),
        (e: unknown) => isModelRequestError(e) && e.status === 400,
      );
    } finally {
      rejected.restore();
    }
    const transient = mockFetchSteps([
      { status: 200, body: { error: { code: 400, message: "ServiceUnavailable: overloaded" } } },
      { status: 200, body: { choices: [{ message: { content: "ok" } }] } },
    ]);
    try {
      const out = await adapterFor(["m"]).propose({ messages: [{ role: "user", content: "hi" }], tools: [] });
      assert.equal(out.type, "stop");
    } finally {
      transient.restore();
    }
  });

  it("transport errors are structured: kind/status/model/attempts/total_attempts on the object and in JSON", async () => {
    const { restore } = mockFetchSteps([{ status: 503, text: "upstream down" }]);
    try {
      const err = await adapterFor(["a", "b"], { maxAttempts: 2 })
        .propose({ messages: [{ role: "user", content: "hi" }], tools: [] })
        .then(
          () => assert.fail("expected an infra error"),
          (e: unknown) => e,
        );
      assert.ok(isModelInfraError(err));
      assert.equal(err.kind, "server_error");
      assert.equal(err.status, 503);
      assert.equal(err.model, "b", "last model tried");
      assert.equal(err.attempts, 2, "requests to that model");
      assert.equal(err.total_attempts, 4, "requests across the fallback chain");
      const json = JSON.parse(JSON.stringify(err)) as Record<string, unknown>;
      assert.deepEqual(
        { ...json, message: undefined },
        {
          name: "ModelInfraError",
          infra: true,
          kind: "server_error",
          status: 503,
          model: "b",
          attempts: 2,
          total_attempts: 4,
          message: undefined,
        },
      );
      assert.match(String(json.message), /HTTP 503/);
      assert.deepEqual(modelTransportErrorJson(err), json);
      assert.equal(modelTransportErrorJson(new Error("x")), null);
    } finally {
      restore();
    }
  });

  it("provider error embedded in a 2xx body is infra, not a stop", async () => {
    const { calls, restore } = mockFetchSteps([
      { status: 200, body: { error: { code: 502, message: "provider returned error" } } },
      { status: 200, body: { choices: [{ message: { content: "recovered" } }] } },
    ]);
    try {
      const out = await adapterFor(["m"]).propose({ messages: [{ role: "user", content: "hi" }], tools: [] });
      assert.equal(out.type, "stop");
      if (out.type === "stop") assert.equal(out.message, "recovered");
      assert.equal(calls.length, 2);
    } finally {
      restore();
    }
  });

  it("non-JSON 2xx body is server_error infra", async () => {
    const { restore } = mockFetchSteps([{ status: 200, text: "<html>gateway</html>" }]);
    try {
      await assert.rejects(
        adapterFor(["m"], { maxAttempts: 2 }).propose({ messages: [{ role: "user", content: "hi" }], tools: [] }),
        (e: unknown) => isModelInfraError(e) && e.kind === "server_error",
      );
    } finally {
      restore();
    }
  });

  it("error messages are bounded and redact key-like text", () => {
    const e = new ModelInfraError("server_error", boundProviderText(`Bearer abcdefghijklmnop ${"x".repeat(2000)}`));
    assert.ok(!e.message.includes("abcdefghijklmnop"));
    assert.ok(Array.from(e.message).length <= 501);
  });
});

describe("OpenAICompatibleAdapter one tool per step (EDGE-13)", () => {
  it("requests parallel_tool_calls:false and rejects multi-call turns explicitly", async () => {
    const { calls, restore } = mockFetchSteps([
      {
        status: 200,
        body: toolCallMsg([
          { id: "c1", name: "faust_tool_0001", args: "{\"path\":\"a\"}" },
          { id: "c2", name: "faust_tool_0002", args: "{\"path\":\"b\"}" },
        ]),
      },
    ]);
    try {
      const out = await adapterFor(["m"]).propose({
        messages: [{ role: "user", content: "hi" }],
        tools: twoTools,
        tool_choice: "required",
      });
      assert.equal(calls[0]!.body.parallel_tool_calls, false);
      assert.equal(out.type, "invalid");
      if (out.type === "invalid") {
        assert.equal(out.reason, "multiple_tool_calls");
        const raw = JSON.parse(out.raw ?? "[]") as Array<{ name: string }>;
        assert.deepEqual(
          raw.map((r) => r.name),
          ["fs.read", "fs.list"],
        );
      }
    } finally {
      restore();
    }
  });

  it("drops the parallel flag once when the endpoint rejects it, and remembers", async () => {
    const { calls, restore } = mockFetchSteps([
      { status: 400, text: "Unrecognized request argument: parallel_tool_calls" },
      { status: 200, body: toolCallMsg([{ id: "c1", name: "faust_tool_0001", args: "{}" }]) },
      { status: 200, body: toolCallMsg([{ id: "c2", name: "faust_tool_0001", args: "{}" }]) },
    ]);
    try {
      const adapter = adapterFor(["m"]);
      const req = { messages: [{ role: "user", content: "hi" }], tools: oneTool, tool_choice: "auto" as const };
      const first = await adapter.propose(req);
      assert.equal(first.type, "tool");
      await adapter.propose(req);
      assert.equal(calls[0]!.body.parallel_tool_calls, false);
      assert.equal("parallel_tool_calls" in calls[1]!.body, false);
      assert.equal("parallel_tool_calls" in calls[2]!.body, false);
    } finally {
      restore();
    }
  });

  it("does not send the parallel flag when the profile declares it unsupported", async () => {
    const { calls, restore } = mockFetchSteps([
      { status: 200, body: toolCallMsg([{ id: "c1", name: "faust_tool_0001", args: "{}" }]) },
    ]);
    try {
      await adapterFor(["m"], { capabilities: { ...caps, parallel_tool_calls_param: false } }).propose({
        messages: [{ role: "user", content: "hi" }],
        tools: oneTool,
      });
      assert.equal("parallel_tool_calls" in calls[0]!.body, false);
    } finally {
      restore();
    }
  });
});

describe("OpenAICompatibleAdapter tool argument shape (EDGE-13)", () => {
  async function argsOutcome(args: string) {
    const { restore } = mockFetchSteps([
      { status: 200, body: toolCallMsg([{ id: "c1", name: "faust_tool_0001", args }]) },
    ]);
    try {
      return await adapterFor(["m"]).propose({
        messages: [{ role: "user", content: "hi" }],
        tools: oneTool,
        tool_choice: "auto",
      });
    } finally {
      restore();
    }
  }

  it("null / array / scalar arguments are invalid tool_arguments_not_object", async () => {
    for (const raw of ["null", "[1,2]", "\"x\"", "3"]) {
      const out = await argsOutcome(raw);
      assert.equal(out.type, "invalid", raw);
      if (out.type === "invalid") assert.equal(out.reason, "tool_arguments_not_object", raw);
    }
  });

  it("empty arguments string is an empty object", async () => {
    const out = await argsOutcome("");
    assert.equal(out.type, "tool");
    if (out.type === "tool") assert.deepEqual(out.args, {});
  });

  it("non-integral numbers are rejected at entry (D3)", async () => {
    const out = await argsOutcome("{\"n\":1.5}");
    assert.equal(out.type, "invalid");
    if (out.type === "invalid") assert.equal(out.reason, "tool_arguments_non_canonical");
    const ok = await argsOutcome("{\"n\":1e3}");
    assert.equal(ok.type, "tool");
    if (ok.type === "tool") assert.equal(ok.args.n, 1000);
  });
});

describe("OpenAICompatibleAdapter provider fields (EDGE-13)", () => {
  const reasoning = [{ type: "reasoning.text", text: "think" }];

  it("returns preserved fields on the proposal and never re-sends them at the request root", async () => {
    const { calls, restore } = mockFetchSteps([
      {
        status: 200,
        body: toolCallMsg([{ id: "c1", name: "faust_tool_0001", args: "{}" }], { reasoning_details: reasoning }),
      },
      { status: 200, body: { choices: [{ message: { content: "done" } }] } },
    ]);
    try {
      const adapter = adapterFor(["m"], { preserveResponseFields: ["reasoning_details"] });
      const first = await adapter.propose({ messages: [{ role: "user", content: "hi" }], tools: oneTool });
      assert.equal(first.type, "tool");
      assert.deepEqual(first.provider_fields, { reasoning_details: reasoning });
      assert.equal(first.model, "m");
      await adapter.propose({
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "c1", type: "function", function: { name: "faust_tool_0001", arguments: "{}" } }],
            model: "m",
            provider_fields: first.provider_fields,
          },
          { role: "tool", tool_call_id: "c1", content: "{}" },
        ],
        tools: oneTool,
      });
      const second = calls[1]!.body;
      assert.equal("reasoning_details" in second, false, "must not be at request root");
      const wire = second.messages as Array<Record<string, unknown>>;
      assert.deepEqual(wire[1]!.reasoning_details, reasoning);
      for (const m of wire) {
        assert.equal("provider_fields" in m, false);
        assert.equal("model" in m, false);
      }
    } finally {
      restore();
    }
  });

  it("drops another model's preserved fields on fallback", () => {
    const wire = wireMessages(
      [
        { role: "assistant", content: "x", model: "other", provider_fields: { reasoning_details: reasoning } },
        { role: "assistant", content: "y", model: "m", provider_fields: { reasoning_details: reasoning } },
      ],
      "m",
    );
    assert.equal("reasoning_details" in wire[0]!, false);
    assert.deepEqual(wire[1]!.reasoning_details, reasoning);
  });

  it("does not leak preserved fields across conversations on a shared adapter", async () => {
    const { calls, restore } = mockFetchSteps([
      { status: 200, body: { choices: [{ message: { content: "a", reasoning_details: reasoning } }] } },
      { status: 200, body: { choices: [{ message: { content: "b" } }] } },
    ]);
    try {
      const adapter = adapterFor(["m"], { preserveResponseFields: ["reasoning_details"] });
      await adapter.propose({ messages: [{ role: "user", content: "conversation one" }], tools: [] });
      await adapter.propose({ messages: [{ role: "user", content: "conversation two" }], tools: [] });
      assert.equal(JSON.stringify(calls[1]!.body).includes("reasoning"), false);
    } finally {
      restore();
    }
  });
});

describe("OpenAICompatibleAdapter per-call log (completion ids)", () => {
  it("records every request with its completion id and flags repeated ids (gateway cache hits)", async () => {
    const reply = { id: "chatcmpl-same", created: 1760000000, choices: [{ message: { content: "hi" } }] };
    const { restore } = mockFetchSteps([
      { status: 503, text: "busy" },
      { status: 200, body: reply },
      { status: 200, body: reply },
      { status: 200, body: { ...reply, id: "chatcmpl-other" } },
    ]);
    const seen: number[] = [];
    try {
      const adapter = adapterFor(["m"], { onCall: (r) => seen.push(r.seq) });
      const first = await adapter.propose({ messages: [{ role: "user", content: "hi" }], tools: [] });
      const second = await adapter.propose({ messages: [{ role: "user", content: "hi" }], tools: [] });
      const third = await adapter.propose({ messages: [{ role: "user", content: "hi" }], tools: [] });
      assert.deepEqual(
        adapter.callLog.map((r) => ({
          seq: r.seq,
          attempt: r.attempt,
          status: r.status,
          outcome: r.outcome,
          completion_id: r.completion_id,
          repeat_of: r.repeat_of,
          error_kind: r.error_kind,
        })),
        [
          { seq: 1, attempt: 1, status: 503, outcome: "http_error", completion_id: undefined, repeat_of: undefined, error_kind: "server_error" },
          { seq: 2, attempt: 2, status: 200, outcome: "ok", completion_id: "chatcmpl-same", repeat_of: undefined, error_kind: undefined },
          { seq: 3, attempt: 1, status: 200, outcome: "ok", completion_id: "chatcmpl-same", repeat_of: 2, error_kind: undefined },
          { seq: 4, attempt: 1, status: 200, outcome: "ok", completion_id: "chatcmpl-other", repeat_of: undefined, error_kind: undefined },
        ],
      );
      assert.deepEqual(seen, [1, 2, 3, 4]);
      assert.equal(first.completion_id, "chatcmpl-same");
      assert.equal(first.call_seq, 2);
      assert.equal(first.repeat_of_call, undefined);
      assert.equal(second.repeat_of_call, 2, "the proposal itself says it repeats call 2");
      assert.equal(third.completion_id, "chatcmpl-other");
      assert.equal(adapter.callLog[1]!.created, 1760000000);
      assert.equal(adapter.drainCallLog().length, 4);
      assert.equal(adapter.callLog.length, 0);
    } finally {
      restore();
    }
  });

  it("timeouts and network failures are logged without a status", async () => {
    const { restore } = mockFetchSteps([{ throws: new TypeError("fetch failed") }]);
    try {
      const adapter = adapterFor(["m"], { maxAttempts: 1 });
      await assert.rejects(adapter.propose({ messages: [{ role: "user", content: "hi" }], tools: [] }));
      assert.equal(adapter.callLog.length, 1);
      assert.equal(adapter.callLog[0]!.status, null);
      assert.equal(adapter.callLog[0]!.outcome, "network");
      assert.equal(adapter.callLog[0]!.error_kind, "network");
    } finally {
      restore();
    }
  });
});
