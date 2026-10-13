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
  state: {},
  tools: [
    {
      id: "fs.read",
      input: { type: "object", properties: {} },
      output: { type: "object", properties: {} },
    },
    {
      id: "task.complete",
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
        "task.complete": { native: "sim.task_complete" },
      },
    };
    const tools = resolveToolsFromDeployment(agent, deployment);
    assert.ok(tools["fs.read"]);
    assert.ok(tools["task.complete"]);
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
        "task.complete": { native: "sim.task_complete" },
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

describe("EDGE-20: simulated bindings enforce the same policy as the local adapter", () => {
  const simAgent: AgentIR = {
    spec: "counterbalance-contract/v0.1",
    name: "sim-policy",
    state: {},
    tools: [
      { id: "fs.read", input: { type: "object" }, output: { type: "object" } },
      { id: "fs.write_scoped", input: { type: "object" }, output: { type: "object" } },
      { id: "shell.run_allowlisted", input: { type: "object" }, output: { type: "object" } },
    ],
    permissions: {
      filesystem: { write_scopes: ["src/", "tests/"] },
      protected_paths: ["tests/x.py"],
      secrets: { values: ["sk-or-v1-simsecretvalue000000000000000"] },
    },
  };
  const simDeployment: Deployment = {
    model: { transport: "recorded" },
    bindings: {
      "fs.read": { native: "stub.fs_read" },
      "fs.write_scoped": { native: "stub.fs_write" },
      "shell.run_allowlisted": { native: "stub.shell" },
    },
  };
  type Env = { output: Record<string, unknown>; state_transition?: { set?: Record<string, unknown> } };

  it("initialises protected paths and secrets for stub/sim natives", async () => {
    const tools = resolveToolsFromDeployment(simAgent, simDeployment, { files: { "tests/x.py": "orig" } });
    const prot = (await tools["fs.write_scoped"]!({ path: "tests//x.py", content: "pwned" }, { state: {} })) as Env;
    assert.equal(prot.output.protected_modified, 1);
    const leak = (await tools["fs.write_scoped"]!(
      { path: "src/a.ts", content: "sk-or-v1-simsecretvalue000000000000000" },
      { state: {} },
    )) as Env;
    assert.equal(leak.output.secret_leak, 1);
  });

  it("sim shell reports the exit code only; the IR's declared effect sets test evidence (D11)", async () => {
    const tools = resolveToolsFromDeployment(simAgent, simDeployment, { testExit: 0 });
    const r = (await tools["shell.run_allowlisted"]!({ cmd: "test" }, { state: {} })) as Env;
    assert.equal(r.output.exit_code, 0);
    assert.equal(r.state_transition, undefined);
    const failing = resolveToolsFromDeployment(simAgent, simDeployment, { testExit: 2 });
    const f = (await failing["shell.run_allowlisted"]!({ cmd: "test" }, { state: {} })) as Env;
    assert.equal(f.output.exit_code, 2);
    assert.equal(f.state_transition, undefined);

    const { FaustRuntime } = await import("../runtime.js");
    const withEffect: AgentIR = {
      spec: "counterbalance-contract/v0.1",
      name: "fx",
      state: { test_evidence_current: 0 },
      tools: [
        {
          id: "shell.run_allowlisted",
          input: { type: "object" },
          output: { type: "object" },
          effects: [{ when: { path: "result.exit_code", eq: 0 }, set: { test_evidence_current: 1 } }],
        },
      ],
      permissions: { tools: ["shell.run_allowlisted"] },
    };
    for (const [testExit, want] of [[0, 1], [2, 0]] as const) {
      const queue = [{ type: "tool" as const, name: "shell.run_allowlisted", args: { cmd: "test" } }];
      const rt = new FaustRuntime({
        agent: withEffect,
        propose: async () => queue.shift() ?? { type: "stop" },
        tools: resolveToolsFromDeployment(
          withEffect,
          { model: { transport: "recorded" }, bindings: { "shell.run_allowlisted": { native: "stub.shell" } } },
          { testExit },
        ),
      });
      await rt.runLoop();
      assert.equal(rt.agent.state.test_evidence_current, want, `exit ${testExit}`);
    }
  });

  it("D14: no scripted or stub user natives remain", () => {
    const userAgent: AgentIR = {
      spec: "counterbalance-contract/v0.1",
      name: "u",
      state: {},
      tools: [{ id: "user.approve", input: { type: "object" }, output: { type: "object" } }],
    };
    for (const native of [
      "stub.approve",
      "sim.approve",
      "local.user_approve",
      "local.user_approve_auto",
      "stub.user_correct",
      "local.user_correct_auto",
    ]) {
      assert.throws(
        () =>
          resolveToolsFromDeployment(
            userAgent,
            { model: { transport: "recorded" }, bindings: { "user.approve": { native } } },
            { workspace: "/nonexistent" },
          ),
        /D14/,
        native,
      );
    }
  });

  it("sim reads do not fall back to write scopes; declared read scopes are enforced", async () => {
    const open = resolveToolsFromDeployment(simAgent, simDeployment, { files: { "docs/readme.md": "hi" } });
    const r = (await open["fs.read"]!({ path: "docs/readme.md" }, { state: {} })) as Env;
    assert.equal(r.output.found, 1, "no read scopes declared → unrestricted, like local");
    const scoped = resolveToolsFromDeployment(
      { ...simAgent, permissions: { ...simAgent.permissions, filesystem: { read_scopes: ["src/"], write_scopes: ["src/"] } } },
      simDeployment,
      { files: { "docs/readme.md": "hi" } },
    );
    const d = (await scoped["fs.read"]!({ path: "docs/readme.md" }, { state: {} })) as Env;
    assert.equal(d.output.error, "scope_denied");
  });

  it("absent write scopes mean no writes (sim matches local)", async () => {
    const noWrite = resolveToolsFromDeployment(
      { ...simAgent, permissions: { filesystem: { read_scopes: ["src/"] } } },
      simDeployment,
    );
    const w = (await noWrite["fs.write_scoped"]!({ path: "src/app.ts", content: "x" }, { state: {} })) as Env;
    assert.equal(w.output.out_of_scope, 1);
  });

  it("host control dir is reserved in the simulated world too", async () => {
    const tools = resolveToolsFromDeployment(
      { ...simAgent, permissions: { filesystem: { write_scopes: ["."] } } },
      simDeployment,
    );
    const w = (await tools["fs.write_scoped"]!({ path: ".fausth/approved_paths.json", content: "{}" }, { state: {} })) as Env;
    assert.equal(w.output.ok, 0);
    assert.equal(w.output.error, "host_reserved");
  });
});
