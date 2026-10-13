import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAdapterFromDeployment, filterModelsByDataPolicy } from "./resolve.js";
import { resolveProfile } from "./profiles/index.js";
import type { Deployment } from "../types.js";

describe("provider profiles", () => {
  it("resolves kit-scc defaults", () => {
    const p = resolveProfile("kit-scc");
    assert.equal(p.defaultBaseUrl, "https://ki-toolbox.scc.kit.edu/api/v1");
    assert.equal(p.defaultApiKeyEnv, "KIT_AI_API_KEY");
    assert.ok(p.compatibility?.prohibited_model_aliases?.includes("standard-external"));
  });
});

describe("data_policy filter", () => {
  it("keeps only residency-matching models", () => {
    const dep: Deployment = {
      model: { transport: "openai-compatible", profile: "kit-scc", models: ["a", "b"] },
      bindings: {},
      data_policy: { require: { residency: "kit-local" } },
      model_catalog: [
        { id: "a", policy: { residency: "kit-local", personal_data: "allowed" } },
        { id: "b", policy: { residency: "external", personal_data: "prohibited" } },
      ],
    };
    assert.deepEqual(filterModelsByDataPolicy(["a", "b"], dep), ["a"]);
  });
  it("throws when none match", () => {
    const dep: Deployment = {
      model: { transport: "openai-compatible", models: ["b"] },
      bindings: {},
      data_policy: { require: { residency: "kit-local" } },
      model_catalog: [{ id: "b", policy: { residency: "external" } }],
    };
    assert.throws(() => filterModelsByDataPolicy(["b"], dep));
  });
});

describe("data_policy fails closed (EDGE-14)", () => {
  it("throws when residency is required but model_catalog is missing", () => {
    const dep: Deployment = {
      model: { transport: "openai-compatible", models: ["a"] },
      bindings: {},
      data_policy: { require: { residency: "kit-local" } },
    };
    assert.throws(() => filterModelsByDataPolicy(["a"], dep), /model_catalog/);
  });
  it("throws when residency is required but model_catalog is empty", () => {
    const dep: Deployment = {
      model: { transport: "openai-compatible", models: ["a"] },
      bindings: {},
      data_policy: { require: { residency: "kit-local" } },
      model_catalog: [],
    };
    assert.throws(() => filterModelsByDataPolicy(["a"], dep), /fail closed/);
  });
  it("createAdapterFromDeployment refuses a residency policy without catalog", () => {
    const prev = process.env.FAUSTH_TEST_FAKE_KEY;
    process.env.FAUSTH_TEST_FAKE_KEY = "fake-test-key";
    try {
      const dep: Deployment = {
        model: {
          transport: "openai-compatible",
          base_url: "https://example.test/v1",
          api_key_env: "FAUSTH_TEST_FAKE_KEY",
          models: ["a"],
        },
        bindings: {},
        data_policy: { require: { residency: "kit-local" } },
      };
      assert.throws(() => createAdapterFromDeployment(dep), /model_catalog/);
    } finally {
      if (prev === undefined) delete process.env.FAUSTH_TEST_FAKE_KEY;
      else process.env.FAUSTH_TEST_FAKE_KEY = prev;
    }
  });
  it("no residency requirement leaves the model list untouched", () => {
    const dep: Deployment = { model: { models: ["a"] }, bindings: {} };
    assert.deepEqual(filterModelsByDataPolicy(["a"], dep), ["a"]);
  });
});

describe("deployment model options", () => {
  function withFakeKey<T>(fn: () => T): T {
    const prev = process.env.FAUSTH_TEST_FAKE_KEY;
    process.env.FAUSTH_TEST_FAKE_KEY = "fake-test-key";
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.FAUSTH_TEST_FAKE_KEY;
      else process.env.FAUSTH_TEST_FAKE_KEY = prev;
    }
  }
  const base = {
    transport: "openai-compatible" as const,
    base_url: "https://example.test/v1",
    api_key_env: "FAUSTH_TEST_FAKE_KEY",
    models: ["m"],
  };

  it("rejects a non-positive / non-integer timeout_ms", () => {
    for (const t of [0, -5, 1.5, "30"]) {
      assert.throws(
        () =>
          withFakeKey(() =>
            createAdapterFromDeployment({ model: { ...base, timeout_ms: t } as Deployment["model"], bindings: {} }),
          ),
        /timeout_ms/,
      );
    }
  });

  it("honours deployment-level compatibility.preserve_response_fields", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "x", reasoning_content: "because" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    try {
      const { adapter } = withFakeKey(() =>
        createAdapterFromDeployment({
          model: { ...base, compatibility: { preserve_response_fields: ["reasoning_content"] } },
          bindings: {},
        }),
      );
      const out = await adapter.propose({ messages: [{ role: "user", content: "hi" }], tools: [] });
      assert.deepEqual(out.provider_fields, { reasoning_content: "because" });
    } finally {
      globalThis.fetch = original;
    }
  });
});
