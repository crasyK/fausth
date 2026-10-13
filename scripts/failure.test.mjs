/**
 * SCR-13: infrastructure failures are classified from structured errors or exact
 * known infra codes only — never from words like "missing"/"adapter"/"workspace".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyFailure, missingApiKeyFailure } from "./lib/failure.mjs";

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
    // A 400 from the provider is not infrastructure (prompt/harness problem).
    assert.equal(classifyFailure({ stderr: "OpenAI-compatible error 400: context too long" }).infra, false);
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
