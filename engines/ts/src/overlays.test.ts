/**
 * Overlay unit tests (M18).
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

describe("resolveOverlay", () => {
  it("narrows tools and limits for matching model", () => {
    const dep = { model: { model: "kit.small" }, bindings: {} } as Deployment;
    const r = resolveOverlay(base, dep);
    assert.equal(r.reason, "matched kit.small");
    assert.deepEqual(r.agent.permissions?.tools, ["fs.read"]);
    assert.equal(r.agent.limits?.max_steps, 10);
    assert.equal(r.agent.tools.length, 1);
  });

  it("rejects widening tools", () => {
    const bad = {
      ...base,
      overlays: [{ when_model: "kit.small", tools: ["fs.read", "shell.run_allowlisted"] }],
    };
    const dep = { model: { model: "kit.small" }, bindings: {} } as Deployment;
    assert.throws(() => resolveOverlay(bad, dep), /widens tools/);
  });

  it("falls back when model unmatched", () => {
    const dep = { model: { model: "other" }, bindings: {} } as Deployment;
    const r = resolveOverlay(base, dep);
    assert.equal(r.overlay, null);
    assert.match(r.reason, /no overlay/);
  });
});
