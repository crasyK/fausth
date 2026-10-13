/**
 * EDGE-8/9/10/23 + PY-3: MCP/module stdio sessions (spawn errors, timeouts, late replies,
 * concurrency, env allowlist, stderr drain, cleanup, spawn policy, recorded matching).
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentIR, Deployment, ToolResultEnvelope } from "../types.js";
import { AdapterError } from "./error.js";
import { createModuleHandlers } from "./module.js";
import { createMcpHandlers } from "./mcp.js";
import { bindToolsFromDeployment } from "./registry.js";
import { registerBundleDir, unregisterBundleDir } from "./provenance.js";
import { liveHostSessionCount, closeAllHostSessions } from "./stdio-session.js";

const MODULE_SERVER = `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.tool === "slow.call") {
    setTimeout(() => process.stdout.write(JSON.stringify({ output: { late: 1 } }) + "\\n"), 400);
    return;
  }
  if (msg.tool === "env.dump") {
    process.stdout.write(JSON.stringify({ output: { keys: Object.keys(process.env).sort() } }) + "\\n");
    return;
  }
  if (msg.tool === "noisy.call") {
    process.stderr.write("x".repeat(1 << 20));
    process.stdout.write(JSON.stringify({ output: { ok: 1 } }) + "\\n");
    return;
  }
  const delay = Number(msg.args?.delay ?? 0);
  setTimeout(() => process.stdout.write(JSON.stringify({ output: { echo: msg.args?.message ?? null } }) + "\\n"), delay);
});
`;

const MCP_SERVER = `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } }) + "\\n");
    return;
  }
  if (msg.method === "tools/call") {
    const delay = Number(msg.params.arguments.delay ?? 0);
    setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { structuredContent: { echo: msg.params.arguments.message } } }) + "\\n"), delay);
  }
});
`;

function moduleDeployment(dir: string, tools: string[], extra: Record<string, unknown> = {}): Deployment {
  return {
    model: { transport: "recorded" },
    bindings: Object.fromEntries(tools.map((t) => [t, { native: `module.srv.${t}` }])),
    module: {
      srv: { transport: "stdio", command: process.execPath, args: [join(dir, "module-server.cjs")], timeout_ms: 200, ...extra },
    },
  } as Deployment;
}

describe("stdio host sessions", () => {
  let dir = "";
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "fausth-stdio-"));
    writeFileSync(join(dir, "module-server.cjs"), MODULE_SERVER);
    writeFileSync(join(dir, "mcp-server.cjs"), MCP_SERVER);
  });
  after(() => {
    closeAllHostSessions();
    rmSync(dir, { recursive: true, force: true });
  });

  it("EDGE-8: a missing executable is an adapter error, not a crash", async () => {
    const dep = moduleDeployment(dir, ["echo.call"]);
    (dep.module!.srv as { command: string }).command = join(dir, "does-not-exist");
    const { handlers, cleanup } = createModuleHandlers(dep, { harnessDir: dir });
    await assert.rejects(
      async () => handlers["echo.call"]!({ message: "x" }, { state: {} }),
      (e: unknown) => e instanceof AdapterError && e.code === "host_session_failed",
    );
    cleanup();
  });

  it("EDGE-8: a late reply after a timeout is never delivered to the next call", async () => {
    const { handlers, cleanup } = createModuleHandlers(moduleDeployment(dir, ["slow.call", "echo.call"]), { harnessDir: dir });
    await assert.rejects(async () => handlers["slow.call"]!({}, { state: {} }), /timeout/);
    await new Promise((r) => setTimeout(r, 500)); // the late reply would arrive now
    const r = (await handlers["echo.call"]!({ message: "fresh" }, { state: {} })) as ToolResultEnvelope;
    assert.deepEqual(r.output, { echo: "fresh" });
    cleanup();
  });

  it("EDGE-8: concurrent module calls each get their own reply", async () => {
    const dep = moduleDeployment(dir, ["echo.call"]);
    (dep.module!.srv as { timeout_ms: number }).timeout_ms = 2000;
    const { handlers, cleanup } = createModuleHandlers(dep, { harnessDir: dir });
    const [a, b, c] = (await Promise.all([
      handlers["echo.call"]!({ message: "a", delay: 60 }, { state: {} }),
      handlers["echo.call"]!({ message: "b", delay: 0 }, { state: {} }),
      handlers["echo.call"]!({ message: "c", delay: 20 }, { state: {} }),
    ])) as ToolResultEnvelope[];
    assert.deepEqual([a!.output.echo, b!.output.echo, c!.output.echo], ["a", "b", "c"]);
    cleanup();
  });

  it("EDGE-9: children get an allowlisted env (no API keys / tokens), plus declared non-secret pass-through", async () => {
    process.env.FAKE_PROVIDER_API_KEY = "sk-fake-provider-key-0123456789abcdef";
    process.env.FAUSTH_TEST_PASSTHROUGH = "visible";
    try {
      const dep = moduleDeployment(dir, ["env.dump"], { env_passthrough: ["FAUSTH_TEST_PASSTHROUGH"], timeout_ms: 2000 });
      const { handlers, cleanup } = createModuleHandlers(dep, { harnessDir: dir });
      const r = (await handlers["env.dump"]!({}, { state: {} })) as ToolResultEnvelope;
      const keys = r.output.keys as string[];
      assert.ok(!keys.includes("FAKE_PROVIDER_API_KEY"));
      assert.ok(keys.includes("FAUSTH_TEST_PASSTHROUGH"));
      assert.ok(!keys.some((k) => /token|api_key|secret/i.test(k)), keys.join(","));
      cleanup();
      assert.throws(
        () => createModuleHandlers(moduleDeployment(dir, ["env.dump"], { env_passthrough: ["OPENROUTER_API_KEY"] }), { harnessDir: dir }),
        /secret-like/,
      );
    } finally {
      delete process.env.FAKE_PROVIDER_API_KEY;
      delete process.env.FAUSTH_TEST_PASSTHROUGH;
    }
  });

  it("EDGE-10: stderr floods are drained; cleanup from bindToolsFromDeployment kills the child", async () => {
    const agent: AgentIR = {
      spec: "counterbalance-contract/v0.1",
      name: "m",
      state: {},
      tools: [{ id: "noisy.call", input: { type: "object" }, output: { type: "object" } }],
    };
    const dep = moduleDeployment(dir, ["noisy.call"], { timeout_ms: 5000 });
    const before = liveHostSessionCount();
    const { tools, cleanup } = bindToolsFromDeployment(agent, dep, { harnessDir: dir });
    const r = (await tools["noisy.call"]!({}, { state: {} })) as ToolResultEnvelope;
    assert.deepEqual(r.output, { ok: 1 });
    assert.equal(liveHostSessionCount(), before + 1);
    cleanup();
    assert.equal(liveHostSessionCount(), before);
  });

  it("MCP: replies are matched by id under concurrency", async () => {
    const dep = {
      model: { transport: "recorded" },
      bindings: { "echo.call": { native: "mcp.srv.echo.call" } },
      mcp: { srv: { transport: "stdio", command: process.execPath, args: [join(dir, "mcp-server.cjs")], timeout_ms: 2000 } },
    } as unknown as Deployment;
    const { handlers, cleanup } = createMcpHandlers(dep, { harnessDir: dir });
    const rs = (await Promise.all([
      handlers["echo.call"]!({ message: "a", delay: 50 }, { state: {} }),
      handlers["echo.call"]!({ message: "b", delay: 0 }, { state: {} }),
    ])) as ToolResultEnvelope[];
    assert.deepEqual(rs.map((r) => r.output.echo), ["a", "b"]);
    cleanup();
  });

  it("PY-3: commands from a bundle-provided deployment need operator allow and a trusted bundle", async () => {
    const bundleDir = mkdtempSync(join(tmpdir(), "fausth-bundle-sim-"));
    writeFileSync(join(bundleDir, "module-server.cjs"), MODULE_SERVER);
    const dep = moduleDeployment(bundleDir, ["echo.call"], { timeout_ms: 2000 });
    const agent: AgentIR = {
      spec: "counterbalance-contract/v0.1",
      name: "b",
      state: {},
      tools: [{ id: "echo.call", input: { type: "object" }, output: { type: "object" } }],
    };
    const prevAllow = process.env.FAUSTH_ALLOW_COMMANDS;
    delete process.env.FAUSTH_ALLOW_COMMANDS;
    try {
      for (const trust of ["unsigned", "signed-untrusted", "signed-trusted"] as const) {
        registerBundleDir(bundleDir, { bundle: "/x/evil.fausth.json", format: "fausth-harness-bundle/v0.3", trust });
        const noAllow = bindToolsFromDeployment(agent, dep, { harnessDir: bundleDir });
        await assert.rejects(
          async () => noAllow.tools["echo.call"]!({ message: "x" }, { state: {} }),
          (e: unknown) => e instanceof AdapterError && e.code === "spawn_not_allowed",
          trust,
        );
        noAllow.cleanup();
        const allowed = bindToolsFromDeployment(agent, dep, {
          harnessDir: bundleDir,
          spawnPolicy: { allowCommands: [process.execPath] },
        });
        if (trust === "signed-trusted") {
          const r = (await allowed.tools["echo.call"]!({ message: "ok" }, { state: {} })) as ToolResultEnvelope;
          assert.deepEqual(r.output, { echo: "ok" });
        } else {
          await assert.rejects(
            async () => allowed.tools["echo.call"]!({ message: "x" }, { state: {} }),
            (e: unknown) => e instanceof AdapterError && e.code === "spawn_not_allowed",
            trust,
          );
        }
        allowed.cleanup();
      }
      // Explicit override for untrusted bundles.
      registerBundleDir(bundleDir, { bundle: "/x/evil.fausth.json", format: "fausth-harness-bundle/v0.3", trust: "unsigned" });
      const override = bindToolsFromDeployment(agent, dep, {
        harnessDir: bundleDir,
        spawnPolicy: { allowCommands: [process.execPath], allowUntrustedBundles: true },
      });
      const r = (await override.tools["echo.call"]!({ message: "ok" }, { state: {} })) as ToolResultEnvelope;
      assert.deepEqual(r.output, { echo: "ok" });
      override.cleanup();
      // An operator-provided deployment outside the bundle dir is not restricted.
      const op = bindToolsFromDeployment(agent, dep, { harnessDir: bundleDir, deploymentPath: join(dir, "deployment.yml") });
      const r2 = (await op.tools["echo.call"]!({ message: "op" }, { state: {} })) as ToolResultEnvelope;
      assert.deepEqual(r2.output, { echo: "op" });
      op.cleanup();
    } finally {
      unregisterBundleDir(bundleDir);
      if (prevAllow !== undefined) process.env.FAUSTH_ALLOW_COMMANDS = prevAllow;
      rmSync(bundleDir, { recursive: true, force: true });
    }
  });

  it("recorded: exact args only (no tool-only fallback) and contained paths", async () => {
    writeFileSync(
      join(dir, "rec.jsonl"),
      JSON.stringify({ tool: "get_forecast", args: { city: "Berlin" }, result: { summary: "sunny" } }) + "\n",
    );
    const dep = {
      model: { transport: "recorded" },
      bindings: { get_forecast: { native: "mcp.w.get_forecast" } },
      mcp: { w: { transport: "recorded", recorded: "rec.jsonl" } },
    } as unknown as Deployment;
    const { handlers } = createMcpHandlers(dep, { harnessDir: dir });
    await assert.rejects(
      async () => handlers["get_forecast"]!({ city: "Paris" }, { state: {} }),
      (e: unknown) => e instanceof AdapterError && e.code === "recorded_response_missing",
    );
    const ok = (await createMcpHandlers(dep, { harnessDir: dir }).handlers["get_forecast"]!({ city: "Berlin" }, { state: {} })) as ToolResultEnvelope;
    assert.deepEqual(ok.output, { summary: "sunny" });

    const outside = mkdtempSync(join(tmpdir(), "fausth-outside-"));
    writeFileSync(join(outside, "rec.jsonl"), "{}\n");
    mkdirSync(join(dir, "sub"), { recursive: true });
    symlinkSync(join(outside, "rec.jsonl"), join(dir, "sub", "link.jsonl"));
    for (const recorded of ["../rec.jsonl", "/etc/passwd", "sub/link.jsonl"]) {
      const bad = { ...dep, mcp: { w: { transport: "recorded", recorded } } } as unknown as Deployment;
      await assert.rejects(
        async () => createMcpHandlers(bad, { harnessDir: dir }).handlers["get_forecast"]!({ city: "Berlin" }, { state: {} }),
        (e: unknown) => e instanceof AdapterError,
        recorded,
      );
    }
    rmSync(outside, { recursive: true, force: true });
  });
});
