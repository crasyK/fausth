/**
 * SCR-13: infrastructure failures are classified from structured errors or exact
 * known infra codes only — never from words like "missing"/"adapter"/"workspace".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyFailure, findInfraFailureEvent, missingApiKeyFailure } from "./lib/failure.mjs";

describe("classifyFailure", () => {
  it("does not treat harness/config errors containing trigger words as infra", () => {
    for (const message of [
      "adapter failure: no deployment binding for tool 'user.ask' (binding_missing)",
      "missing recorded model trace: /x/recorded/t/counterbalanced.model.jsonl",
      "workspace does not exist: /tmp/x",
      "grader crashed: expected 401 rows, got 403",
      "frozen harness missing for mutable-skills__rep1__m__kit phase implementation",
    ]) {
      const r = classifyFailure({ message });
      assert.equal(r.infra, false, message);
      assert.equal(r.source, "unclassified");
    }
  });

  it("recognises exact transport infra codes", () => {
    assert.deepEqual(classifyFailure({ message: "RATE_LIMIT: daily quota exceeded" }), {
      infra: true,
      kind: "rate_limit",
      code: "RATE_LIMIT",
      source: "known_code",
    });
    assert.equal(
      classifyFailure({ message: "Command failed", stderr: "OpenAI-compatible error 503: upstream" }).kind,
      "gateway",
    );
    assert.equal(classifyFailure({ stderr: "OpenAI-compatible error 401: bad key" }).kind, "auth");
    assert.equal(classifyFailure({ stderr: "TypeError: fetch failed" }).kind, "network");
    assert.equal(classifyFailure({ stderr: "Error: getaddrinfo ENOTFOUND ki-toolbox" }).code, "ENOTFOUND");
    assert.equal(classifyFailure({ message: "model unavailable: kit.x" }).kind, "model_unavailable");
    assert.equal(
      classifyFailure({
        stderr: "fatal: unable to access 'https://github.com/pallets/flask.git/': Could not resolve host: github.com",
      }).code,
      "GIT_NETWORK",
    );
    // The legacy untyped 400 message is not an infra code (prompt/harness problem).
    assert.equal(classifyFailure({ stderr: "OpenAI-compatible error 400: context too long" }).infra, false);
  });

  it("recognises the typed ModelInfraError messages the engine CLI prints", () => {
    const cases = [
      ["RATE_LIMIT: kit.glm-5.3-flash HTTP 429: slow down", "rate_limit", "RATE_LIMIT"],
      ["kit.glm-5.3-flash HTTP 503: upstream", "server_error", "HTTP_503"],
      ["kit.glm-5.3-flash HTTP 401: bad key", "auth", "HTTP_401"],
      ["kit.glm-5.3-flash HTTP 408: slow", "timeout", "HTTP_408"],
      ["kit.glm-5.3-flash HTTP 400: rejected", "bad_request", "HTTP_400"],
      ["model request timed out after 120000ms (kit.glm-5.3-flash)", "timeout", "TIMEOUT"],
      ["model request failed (kit.glm-5.3-flash): fetch failed [ECONNRESET]", "network", "NETWORK"],
      ["malformed (non-JSON) response body from kit.glm-5.3-flash", "server_error", "MALFORMED_BODY"],
      ["kit.glm-5.3-flash: provider error in 2xx body: overloaded", "server_error", "PROVIDER_ERROR"],
      ["no usable response from kit.glm-5.3-flash", "server_error", "NO_USABLE_RESPONSE"],
      ["model unavailable: kit.glm-5.3-flash HTTP 404: gone", "model_unavailable", "MODEL_UNAVAILABLE"],
    ];
    for (const [line, kind, code] of cases) {
      const r = classifyFailure({ message: `Command failed: node src/cli.ts run\n${line}` });
      assert.deepEqual([r.infra, r.kind, r.code], [true, kind, code], line);
    }
    // Not anchored at a line start ⇒ not an infra signature.
    assert.equal(classifyFailure({ stderr: "the agent wrote: kit.glm-5.3-flash HTTP 503: x" }).infra, false);
  });

  it("reads runtime infra_failure events (adapter failures during a run)", () => {
    const events = [
      JSON.stringify({ stage: "execute", tool: "user.ask", verdict: "allow" }),
      JSON.stringify({
        stage: "execute",
        verdict: "deny",
        reason: "infra_failure",
        tool: "user.ask",
        failure: { kind: "adapter", code: "user_channel_unavailable" },
        error: "adapter failure: no recorded user answer for 'user.ask' call #9",
      }),
    ].join("\n");
    assert.deepEqual(findInfraFailureEvent(events), {
      infra: true,
      kind: "adapter:user_channel_unavailable",
      code: "user_channel_unavailable",
      tool: "user.ask",
      message: "adapter failure: no recorded user answer for 'user.ask' call #9",
    });
    assert.equal(findInfraFailureEvent(JSON.stringify({ reason: "tool_execution_failed" })), null);
  });

  it("prefers structured error objects (transport / report / stderr envelope)", () => {
    assert.equal(classifyFailure({ error: { kind: "transport", code: "ECONNRESET" } }).infra, true);
    assert.equal(classifyFailure({ error: { kind: "harness", infra: false }, message: "RATE_LIMIT: x" }).infra, false);
    assert.equal(
      classifyFailure({ report: { error: { kind: "rate_limit", infra: true, code: "429" } } }).source,
      "structured",
    );
    const env = classifyFailure({
      stderr: 'noise\nfausth-error: {"fausth_error":{"kind":"gateway","infra":true,"code":"HTTP_502"}}\n',
    });
    assert.deepEqual(env, { infra: true, kind: "gateway", code: "HTTP_502", source: "structured" });
  });

  it("missing API keys are structured infra failures", () => {
    assert.deepEqual(missingApiKeyFailure("KIT_AI_API_KEY"), {
      infra: true,
      kind: "missing_api_key",
      code: "KIT_AI_API_KEY",
      source: "structured",
    });
  });
});
