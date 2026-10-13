/**
 * Overlay unit tests (spec-v0.3 §4.4; CORE-12).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveOverlay } from "./overlays.js";
import type { AgentIR, Deployment } from "./types.js";

const base: AgentIR = {
  spec: "counterbalance-contract/v0.1",
  name: "overlay-demo",
  state: {},
  tools: [
    { id: "fs.read", input: { type: "object" }, output: { type: "object" } },
    { id: "fs.write_scoped", input: { type: "object" }, output: { type: "object" } },
  ],
  permissions: { tools: ["fs.read", "fs.write_scoped"] },
  limits: { max_steps: 30 },
  overlays: [
    {
      when_model: "kit.small",
      tools: ["fs.read"],
      limits: { max_steps: 10 },
    },
  ],
};

const dep = (model: string) => ({ model: { model }, bindings: {} }) as unknown as Deployment;

describe("resolveOverlay", () => {
  it("narrows permitted tools and limits for the matching model", () => {
    const r = resolveOverlay(base, dep("kit.small"));
    assert.equal(r.reason, "matched kit.small");
    assert.deepEqual(r.agent.permissions?.tools, ["fs.read"]);
    assert.equal(r.agent.limits?.max_steps, 10);
    assert.equal("overlays" in r.agent, false);
  });

  it("keeps tool declarations so references stay valid (capability narrows via permissions)", () => {
    const r = resolveOverlay(base, dep("kit.small"));
    assert.deepEqual(
      r.agent.tools.map((t) => t.id),
      ["fs.read", "fs.write_scoped"],
    );
  });

  it("rejects widening tools", () => {
    const bad = { ...base, overlays: [{ when_model: "kit.small", tools: ["fs.read", "shell.run_allowlisted"] }] };
    assert.throws(() => resolveOverlay(bad, dep("kit.small")), /widens tools/);
  });

  it("rejects tools that are declared but not permitted", () => {
    const narrow = { ...base, permissions: { tools: ["fs.read"] }, overlays: [{ when_model: "m", tools: ["fs.write_scoped"] }] };
    assert.throws(() => resolveOverlay(narrow, dep("m")), /widens tools/);
  });

  it("CORE-12: cannot widen a limit that was unset (effective default 1000)", () => {
    const unset = { ...base, limits: undefined, overlays: [{ when_model: "m", limits: { max_steps: 99999 } }] };
    assert.throws(() => resolveOverlay(unset, dep("m")), /widens limits.max_steps: 99999 > 1000/);
    const ok = resolveOverlay({ ...unset, overlays: [{ when_model: "m", limits: { max_steps: 50 } }] }, dep("m"));
    assert.equal(ok.agent.limits?.max_steps, 50);
  });

  it("CORE-12: rejects NaN, negative and non-integer limits", () => {
    for (const v of [Number.NaN, -1, 2.5]) {
      const bad = { ...base, overlays: [{ when_model: "m", limits: { max_tool_calls: v } }] };
      assert.throws(() => resolveOverlay(bad, dep("m")), /must be an integer/);
    }
  });

  it("falls back when model unmatched", () => {
    const r = resolveOverlay(base, dep("other"));
    assert.equal(r.overlay, null);
    assert.match(r.reason, /no overlay/);
  });
});
