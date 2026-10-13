/** D15 + gateway caching amendment: KIT model defaults and cache warnings. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ALL_KIT_MODELS,
  DEFAULT_KIT_MODEL,
  assertLiveKitModels,
  gatewayCacheWarnings,
  isRetiredKitModel,
} from "./lib/kit-models.mjs";

const here = dirname(fileURLToPath(import.meta.url));

describe("KIT model catalog", () => {
  it("defaults to glm-5.3-flash and allows deepseek-v4-flash", () => {
    assert.equal(DEFAULT_KIT_MODEL, "kit.glm-5.3-flash");
    assert.deepEqual(ALL_KIT_MODELS, ["kit.glm-5.3-flash", "kit.deepseek-v4-flash"]);
    assert.doesNotThrow(() => assertLiveKitModels(ALL_KIT_MODELS));
  });

  it("rejects retired ids", () => {
    assert.equal(isRetiredKitModel("kit.minimax-m2.7-229b"), true);
    assert.equal(isRetiredKitModel("kit.gemma4-31b-it"), true);
    assert.throws(() => assertLiveKitModels(["kit.gemma4-31b-it"]), /retired/);
  });

  it("warns when reps > 1 hit the request-body cache", () => {
    assert.deepEqual(gatewayCacheWarnings({ models: ["kit.glm-5.3-flash"], reps: 1 }), []);
    assert.deepEqual(gatewayCacheWarnings({ models: ["kit.deepseek-v4-flash"], reps: 3 }), []);
    const w = gatewayCacheWarnings({ models: ["kit.glm-5.3-flash", "kit.deepseek-v4-flash"], reps: 3 });
    assert.equal(w.length, 1);
    assert.deepEqual(w[0].models, ["kit.glm-5.3-flash"]);
    assert.match(w[0].message, /NOT independent/);
  });

  it("host scripts carry no retired model ids as defaults", () => {
    for (const f of [
      "case-study-coding.mjs",
      "kit-tmux-shard.mjs",
      "opt-arms-tmux.mjs",
      "track-s-measure.sh",
      "live-local-e2e.mjs",
    ]) {
      const src = readFileSync(join(here, f), "utf8");
      assert.doesNotMatch(src, /kit\.(gemma|minimax)/, f);
    }
  });
});
