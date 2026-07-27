import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AdapterError,
  resolveToolsFromDeployment,
} from "./registry.js";
import type { AgentIR, Deployment } from "../types.js";

const agent: AgentIR = {
  spec: "counterbalance-contract/v0.1",
  name: "t",
  state: { mode: "research" },
  tools: [
    {
      id: "fs.read",
      input: { type: "object", properties: {} },
      output: { type: "object", properties: {} },
    },
    {
      id: "mode.enter",
      input: { type: "object", properties: {} },
      output: { type: "object", properties: {} },
    },
  ],
  permissions: { filesystem: { write_scopes: ["src/"] } },
};

describe("resolveToolsFromDeployment", () => {
  it("resolves known simulation natives", () => {
    const deployment: Deployment = {
      platform: "sim",
      model: { transport: "recorded" },
      bindings: {
        "fs.read": { native: "sim.fs_read" },
        "mode.enter": { native: "sim.mode_enter" },
      },
    };
    const tools = resolveToolsFromDeployment(agent, deployment);
    assert.ok(tools["fs.read"]);
    assert.ok(tools["mode.enter"]);
    assert.equal(Object.keys(tools).length, 2);
  });

  it("fails with binding_missing when a tool has no binding", () => {
    const deployment: Deployment = {
      model: { transport: "recorded" },
      bindings: {
        "fs.read": { native: "stub.fs_read" },
      },
    };
    try {
      resolveToolsFromDeployment(agent, deployment);
      assert.fail("expected AdapterError");
    } catch (e) {
      assert.ok(e instanceof AdapterError);
      assert.equal(e.code, "binding_missing");
      assert.match(e.message, /binding_missing/);
    }
  });

  it("fails with adapter_unresolved for unknown native", () => {
    const deployment: Deployment = {
      model: { transport: "recorded" },
      bindings: {
        "fs.read": { native: "no.such.native" },
        "mode.enter": { native: "sim.mode_enter" },
      },
    };
    try {
      resolveToolsFromDeployment(agent, deployment);
      assert.fail("expected AdapterError");
    } catch (e) {
      assert.ok(e instanceof AdapterError);
      assert.equal(e.code, "adapter_unresolved");
      assert.match(e.message, /adapter_unresolved/);
    }
  });
});
