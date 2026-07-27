import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filterModelsByDataPolicy } from "./resolve.js";
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
