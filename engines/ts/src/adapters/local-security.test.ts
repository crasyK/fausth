/**
 * Regression tests for the local adapter trust boundary (EDGE-2/4/5/6/7/18/19/20).
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { AgentIR, Deployment, ToolResultEnvelope } from "../types.js";
import { createLocalCodingTools, createLocalWorld, type LocalWorldOptions } from "./local.js";
import { createTauWorldTools, TAU_WORLD_EXTENSION } from "./worlds/tau.js";
import { SandboxPathError } from "./sandbox-path.js";
import { bindToolsFromDeployment } from "./registry.js";
import { codingWorldFromAgent, createCodingTools } from "../tools/world.js";

type Out = ToolResultEnvelope;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", windowsHide: true, encoding: "utf8" });
}

function makeWorktree(): { primary: string; worktree: string; dispose: () => void } {
  const primary = mkdtempSync(join(tmpdir(), "fausth-sec-primary-"));
  git(primary, "init", "-q");
  git(primary, "config", "user.email", "fausth@test");
  git(primary, "config", "user.name", "fausth");
  mkdirSync(join(primary, "src"), { recursive: true });
  mkdirSync(join(primary, "tests"), { recursive: true });
  mkdirSync(join(primary, "secrets"), { recursive: true });
  writeFileSync(join(primary, "src", "app.ts"), "export {}\n");
  writeFileSync(join(primary, "tests", "x.py"), "def test_x():\n    assert True\n");
  writeFileSync(join(primary, "secrets", "key.txt"), "sk-or-v1-realsecretvalue0000000000000000\n");
  git(primary, "add", ".");
  git(primary, "commit", "-q", "-m", "init");
  const worktree = join(tmpdir(), `fausth-sec-wt-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  git(primary, "worktree", "add", "-q", "--detach", worktree);
  return {
    primary,
    worktree,
    dispose: () => {
      try {
        git(primary, "worktree", "remove", "--force", worktree);
      } catch {
        /* ignore */
      }
      rmSync(primary, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    },
  };
}

function agentWith(permissions: AgentIR["permissions"]): AgentIR {
  return {
    spec: "counterbalance-contract/v0.1",
    name: "sec",
    state: {},
    tools: [],
    permissions,
  };
}

function deploymentWith(world: Deployment["world"] = {}): Deployment {
  return { model: { transport: "recorded" }, bindings: {}, world };
}

function makeTools(opts: Omit<LocalWorldOptions, "interactive">) {
  const world = createLocalWorld({ ...opts, interactive: false });
  return { world, tools: createLocalCodingTools(world) };
}

async function call(
  tools: Record<string, (a: Record<string, unknown>, c: { state: Record<string, unknown> }) => unknown>,
  name: string,
  args: Record<string, unknown>,
  state: Record<string, unknown> = {},
): Promise<Out> {
  return (await tools[name]!(args, { state })) as Out;
}

describe("local adapter trust boundary", () => {
  let wt: ReturnType<typeof makeWorktree>;
  before(() => {
    wt = makeWorktree();
  });
  after(() => wt.dispose());

  it("EDGE-2: an off-plan write to a protected or secret-bearing path is denied before anything is written", async () => {
    const agent = agentWith({
      filesystem: { write_scopes: ["src/", "tests/"] },
      protected_paths: ["tests/x.py"],
      secrets: { values: ["sk-or-v1-realsecretvalue0000000000000000"] },
    });
    const { tools } = makeTools({
      workspace: wt.worktree,
      agent,
      deployment: deploymentWith(),
      approvedWritePaths: ["src/app.ts"],
    });
    const state = {};
    const original = readFileSync(join(wt.worktree, "tests/x.py"), "utf8");

    const prot = await call(tools, "fs.write_scoped", { path: "tests/x.py", content: "def test_x():\n    pass\n" }, state);
    assert.equal(prot.output.ok, 0);
    assert.equal(prot.output.protected_modified, 1);
    assert.equal(readFileSync(join(wt.worktree, "tests/x.py"), "utf8"), original);

    const leak = await call(
      tools,
      "fs.write_scoped",
      { path: "src/leak.ts", content: "const k = 'sk-or-v1-realsecretvalue0000000000000000';\n" },
      state,
    );
    assert.equal(leak.output.ok, 0);
    assert.equal(leak.output.secret_leak, 1);
    assert.equal(existsSync(join(wt.worktree, "src/leak.ts")), false);

    // A benign off-plan write is still allowed once, with the warning flag.
    const warn = await call(tools, "fs.write_scoped", { path: "src/other.ts", content: "x\n" }, state);
    assert.equal(warn.output.ok, 1);
    assert.equal(warn.output.off_plan, 1);
    assert.equal(warn.state_transition?.set?.off_plan_writes, 1);
  });

  it("EDGE-5: protected-path aliases (./, //, /./, symlink) are all denied", async () => {
    symlinkSync("../tests/x.py", join(wt.worktree, "src", "alias.py"));
    try {
      const agent = agentWith({
        filesystem: { write_scopes: ["src/", "tests/"] },
        protected_paths: ["./tests//x.py"],
      });
      const { tools } = makeTools({ workspace: wt.worktree, agent, deployment: deploymentWith() });
      const original = readFileSync(join(wt.worktree, "tests/x.py"), "utf8");
      for (const path of ["./tests/x.py", "tests//x.py", "tests/./x.py", "tests\\x.py", "src/alias.py"]) {
        const r = await call(tools, "fs.write_scoped", { path, content: "pwned\n" });
        assert.equal(r.output.ok, 0, path);
        assert.ok(r.output.protected_modified === 1 || r.output.out_of_scope === 1, path);
      }
      assert.equal(readFileSync(join(wt.worktree, "tests/x.py"), "utf8"), original);
    } finally {
      rmSync(join(wt.worktree, "src", "alias.py"), { force: true });
    }
  });

  it("EDGE-5 (sim): the simulated world normalizes protected paths the same way", () => {
    const world = codingWorldFromAgent(
      { permissions: { filesystem: { write_scopes: ["src/", "tests/"] }, protected_paths: ["tests/x.py"] } },
      { files: { "tests/x.py": "orig" } },
    );
    const tools = createCodingTools(world);
    for (const path of ["./tests/x.py", "tests//x.py", "tests/./x.py"]) {
      const r = tools["fs.write_scoped"]!({ path, content: "pwned" }, { state: {} }) as Out;
      assert.equal(r.output.protected_modified, 1, path);
    }
    assert.equal(world.files["tests/x.py"], "orig");
  });

  it("EDGE-7: an in-scope symlink to an out-of-scope directory does not grant access", async () => {
    symlinkSync("../secrets", join(wt.worktree, "src", "link"));
    try {
      const agent = agentWith({ filesystem: { read_scopes: ["src/"], write_scopes: ["src/"] } });
      const { tools } = makeTools({ workspace: wt.worktree, agent, deployment: deploymentWith() });
      const read = await call(tools, "fs.read", { path: "src/link/key.txt" });
      assert.equal(read.output.found, 0);
      assert.equal(read.output.error, "scope_denied");
      assert.equal(read.output.content, "");
      const list = await call(tools, "fs.list", { path: "src/link" });
      assert.equal(list.output.error, "scope_denied");
      const write = await call(tools, "fs.write_scoped", { path: "src/link/new.txt", content: "x" });
      assert.equal(write.output.ok, 0);
      assert.equal(write.output.out_of_scope, 1);
      assert.equal(existsSync(join(wt.worktree, "secrets", "new.txt")), false);
    } finally {
      rmSync(join(wt.worktree, "src", "link"), { force: true });
    }
  });

  it("EDGE-6: host control files are never agent-writable and approvals are snapshotted", async () => {
    mkdirSync(join(wt.worktree, ".fausth"), { recursive: true });
    writeFileSync(join(wt.worktree, ".fausth/approved_paths.json"), JSON.stringify({ paths: ["src/app.ts"] }));
    symlinkSync("../.fausth", join(wt.worktree, "src", "ctl"));
    try {
      const agent = agentWith({ filesystem: { write_scopes: ["."] } });
      const { tools } = makeTools({ workspace: wt.worktree, agent, deployment: deploymentWith() });
      for (const path of [".fausth/approved_paths.json", "./.fausth/x.json", "src/ctl/approved_paths.json"]) {
        const r = await call(tools, "fs.write_scoped", { path, content: JSON.stringify({ paths: ["src/evil.ts"] }) });
        assert.equal(r.output.ok, 0, path);
        assert.equal(r.output.error, "host_reserved", path);
      }
      assert.deepEqual(JSON.parse(readFileSync(join(wt.worktree, ".fausth/approved_paths.json"), "utf8")).paths, [
        "src/app.ts",
      ]);
      // Even if something rewrites the record mid-run, the world keeps the host snapshot:
      // src/evil.ts stays off-plan (first write warns, second is denied).
      writeFileSync(join(wt.worktree, ".fausth/approved_paths.json"), JSON.stringify({ paths: ["src/evil.ts"] }));
      const warned = await call(tools, "fs.write_scoped", { path: "src/evil.ts", content: "x" });
      assert.equal(warned.output.off_plan, 1);
      const r = await call(tools, "fs.write_scoped", { path: "src/evil.ts", content: "x" });
      assert.equal(r.output.ok, 0);
      assert.equal(r.output.error, "off_plan_path");
      // Harness state cannot widen the host's approvals (D11: never read by key name).
      const viaState = await call(tools, "fs.write_scoped", { path: "src/evil.ts", content: "x" }, {
        allowed_write_paths: ["src/evil.ts"],
      });
      assert.equal(viaState.output.error, "off_plan_path");
    } finally {
      rmSync(join(wt.worktree, "src", "ctl"), { force: true });
      rmSync(join(wt.worktree, ".fausth"), { recursive: true, force: true });
    }
  });

  it("EDGE-6: τ control files are host-only; the final-answer write carries no host effect; tau command is not shell-runnable", async () => {
    const agent = agentWith({ filesystem: { write_scopes: ["tau/", "data/"], read_scopes: ["."] } });
    const deployment = deploymentWith({ commands: { tau: ["node", "-e", "process.exit(0)"] } });
    const world = createLocalWorld({
      workspace: wt.worktree,
      agent,
      deployment,
      interactive: false,
      extensions: [TAU_WORLD_EXTENSION],
    });
    const tools = createLocalCodingTools(world);
    const todos = JSON.stringify({ version: 1, slots: [{ id: "resolve_1", value: "x", filled: true }] });
    for (const path of ["tau/todos.json", "tau/actions.jsonl", "tau/request.json", "./tau//todos.json"]) {
      const r = await call(tools, "fs.write_scoped", { path, content: todos });
      assert.equal(r.output.error, "host_reserved", path);
      assert.equal(r.state_transition?.set?.open_todos, undefined, path);
    }
    // The adapter reports the write; "final answer written ⇒ finalized" is the harness's
    // declared effect on result.path (D11), never a host write of `finalized` by name.
    const fin = await call(tools, "fs.write_scoped", { path: "tau/final.txt", content: "done" });
    assert.equal(fin.output.ok, 1);
    assert.equal(fin.output.path, "tau/final.txt");
    assert.equal(fin.state_transition, undefined);
    const sh = await call(tools, "shell.run_allowlisted", { cmd: "tau" });
    assert.equal(sh.output.exit_code, 1);
    assert.match(String(sh.output.error), /not allowlisted/);
    assert.ok(createTauWorldTools(world)["local.tau_invoke"]);
    rmSync(join(wt.worktree, "tau"), { recursive: true, force: true });
  });

  it("D11: declared IR effects, not the adapter, turn local results into memory", async () => {
    const agent: AgentIR = {
      spec: "counterbalance-contract/v0.1",
      name: "fx",
      state: { finalized: 0, open_todos: 1 },
      tools: [
        {
          id: "fs.write_scoped",
          input: { type: "object" },
          output: { type: "object" },
          effects: [
            {
              when: { all: [{ path: "result.ok", eq: 1 }, { path: "result.path", eq: "tau/final.txt" }] },
              set: { finalized: 1, open_todos: 0 },
            },
          ],
        },
      ],
      permissions: { tools: ["fs.write_scoped"], filesystem: { write_scopes: ["tau/"] } },
    };
    const { FaustRuntime } = await import("../runtime.js");
    const { tools } = makeTools({ workspace: wt.worktree, agent, deployment: deploymentWith() });
    const queue = [
      { type: "tool" as const, name: "fs.write_scoped", args: { path: "tau/notes.txt", content: "n" } },
      { type: "tool" as const, name: "fs.write_scoped", args: { path: "tau/final.txt", content: "done" } },
    ];
    const rt = new FaustRuntime({ agent, propose: async () => queue.shift() ?? { type: "stop" }, tools });
    await rt.runLoop();
    assert.equal(rt.agent.state.finalized, 1);
    assert.equal(rt.agent.state.open_todos, 0);
    rmSync(join(wt.worktree, "tau"), { recursive: true, force: true });
  });

  it("EDGE-4: world commands get a scrubbed env and a private HOME; output is secret-redacted", async () => {
    const prevKey = process.env.FAKE_PROVIDER_API_KEY;
    const prevTok = process.env.GH_TOKEN;
    process.env.FAKE_PROVIDER_API_KEY = "sk-fake-provider-key-0123456789abcdef";
    process.env.GH_TOKEN = "fake-gh-token-value-123456";
    try {
      const script =
        "const e=process.env;" +
        "console.log(JSON.stringify({k:Object.keys(e).sort(),home:e.HOME}));" +
        "console.log('leak:'+(e.FAKE_PROVIDER_API_KEY||'none'));" +
        "console.log('labeled:sk-or-v1-realsecretvalue0000000000000000');" +
        "console.log('host:fake-gh-token-value-123456');";
      const agent = agentWith({
        filesystem: { write_scopes: ["src/"] },
        secrets: { paths: ["secrets/key.txt"] },
      });
      const { tools } = makeTools({
        workspace: wt.worktree,
        agent,
        deployment: deploymentWith({ commands: { test: ["node", "-e", script] } }),
      });
      const r = await call(tools, "shell.run_allowlisted", { cmd: "test" });
      assert.equal(r.output.exit_code, 0);
      const stdout = String(r.output.stdout);
      const first = JSON.parse(stdout.split("\n")[0]!) as { k: string[]; home: string };
      assert.ok(!first.k.some((k) => /api_key|token|secret/i.test(k)), first.k.join(","));
      assert.notEqual(first.home, process.env.HOME);
      assert.match(stdout, /leak:none/);
      assert.ok(!stdout.includes("sk-or-v1-realsecretvalue0000000000000000"));
      assert.ok(!stdout.includes("fake-gh-token-value-123456"));
      assert.match(stdout, /\[REDACTED\]/);
    } finally {
      if (prevKey === undefined) delete process.env.FAKE_PROVIDER_API_KEY;
      else process.env.FAKE_PROVIDER_API_KEY = prevKey;
      if (prevTok === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = prevTok;
    }
  });

  it("EDGE-4: git hooks/config, protected files and control files modified by a command are restored", async () => {
    const commonDir = git(wt.worktree, "rev-parse", "--git-common-dir").trim();
    const hooksDir = join(wt.worktree, commonDir.startsWith("/") ? "" : "", commonDir, "hooks");
    const hookPath = (commonDir.startsWith("/") ? join(commonDir, "hooks") : hooksDir) + "/pre-commit";
    const configPath = (commonDir.startsWith("/") ? commonDir : join(wt.worktree, commonDir)) + "/config";
    const configBefore = readFileSync(configPath);
    mkdirSync(join(wt.worktree, ".fausth"), { recursive: true });
    writeFileSync(join(wt.worktree, ".fausth", "approved_paths.json"), '{"paths":["src/app.ts"]}');
    const script = [
      `require('fs').writeFileSync(${JSON.stringify(hookPath)}, '#!/bin/sh\\necho pwned\\n', {mode: 0o755});`,
      `require('fs').appendFileSync(${JSON.stringify(configPath)}, '\\n[core]\\n\\thooksPath = /tmp/evil\\n');`,
      `require('fs').writeFileSync('tests/x.py', 'def test_x():\\n    pass\\n');`,
      `require('fs').writeFileSync('.fausth/approved_paths.json', '{"paths":["src/evil.ts"]}');`,
    ].join("");
    const agent = agentWith({ filesystem: { write_scopes: ["src/"] }, protected_paths: ["tests/x.py"] });
    const { tools, world } = makeTools({
      workspace: wt.worktree,
      agent,
      deployment: deploymentWith({ commands: { test: ["node", "-e", script] } }),
    });
    const testBefore = readFileSync(join(wt.worktree, "tests/x.py"), "utf8");
    const r = await call(tools, "shell.run_allowlisted", { cmd: "test" });
    assert.equal(r.output.exit_code, 0);
    assert.equal(r.output.protected_modified, 1);
    assert.equal(r.state_transition, undefined, "no test evidence when the command tampered");
    assert.equal(existsSync(hookPath), false);
    assert.deepEqual(readFileSync(configPath), configBefore);
    assert.equal(readFileSync(join(wt.worktree, "tests/x.py"), "utf8"), testBefore);
    assert.equal(readFileSync(join(wt.worktree, ".fausth", "approved_paths.json"), "utf8"), '{"paths":["src/app.ts"]}');
    assert.ok(world.tamperLog.includes("git_hooks_or_config"));
    rmSync(join(wt.worktree, ".fausth"), { recursive: true, force: true });
  });

  it("EDGE-18: verbose passing runs keep exit 0; failures keep their real exit code; timeouts report 124", async () => {
    const agent = agentWith({ filesystem: { write_scopes: ["src/"] } });
    const { tools } = makeTools({
      workspace: wt.worktree,
      agent,
      deployment: deploymentWith({
        max_output_bytes: 1000,
        shell_timeout_ms: 1500,
        commands: {
          test: ["node", "-e", "for (let i = 0; i < 20000; i++) console.log('ok ' + i + ' ✓');"],
          typecheck: ["node", "-e", "process.stderr.write('bad'); process.exit(3)"],
          slow: ["node", "-e", "setTimeout(() => {}, 60000)"],
        },
      }),
    });
    const verbose = await call(tools, "shell.run_allowlisted", { cmd: "test" });
    assert.equal(verbose.output.exit_code, 0);
    assert.equal(verbose.output.truncated, 1);
    assert.ok([...String(verbose.output.stdout)].length <= 1000);
    assert.equal(verbose.state_transition, undefined, "evidence is the harness's declared effect (D11)");
    const failing = await call(tools, "shell.run_allowlisted", { cmd: "typecheck" });
    assert.equal(failing.output.exit_code, 3);
    assert.equal(failing.output.stderr, "bad");
    assert.equal(failing.state_transition, undefined);
    const slow = await call(tools, "shell.run_allowlisted", { cmd: "slow" });
    assert.equal(slow.output.exit_code, 124);
    assert.equal(slow.output.error, "timeout");
  });

  it("EDGE-19: prototype keys are not commands; deployment scopes may only narrow", async () => {
    const agent = agentWith({ filesystem: { write_scopes: ["src/"] } });
    const { tools } = makeTools({ workspace: wt.worktree, agent, deployment: deploymentWith() });
    for (const cmd of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const r = await call(tools, "shell.run_allowlisted", { cmd });
      assert.equal(r.output.exit_code, 1, cmd);
      assert.match(String(r.output.error), /not allowlisted/);
    }
    // Agent declares no write scopes → a deployment may not grant any.
    assert.throws(
      () =>
        createLocalWorld({
          workspace: wt.worktree,
          agent: agentWith({ filesystem: { read_scopes: ["src/"] } }),
          deployment: deploymentWith({ scopes: { write: ["src/"] } }),
        }),
      (e: unknown) => e instanceof SandboxPathError && e.code === "scope_denied",
    );
    // Deployment read scope outside the agent's read scopes widens → rejected.
    assert.throws(() =>
      createLocalWorld({
        workspace: wt.worktree,
        agent: agentWith({ filesystem: { read_scopes: ["src/"], write_scopes: ["src/"] } }),
        deployment: deploymentWith({ scopes: { read: ["."] } }),
      }),
    );
    // Explicit empty deployment write scope narrows to no writes.
    const none = makeTools({
      workspace: wt.worktree,
      agent,
      deployment: deploymentWith({ scopes: { write: [] } }),
    });
    const w = await call(none.tools, "fs.write_scoped", { path: "src/app.ts", content: "x" });
    assert.equal(w.output.out_of_scope, 1);
    // Malformed command argv is rejected at world creation.
    assert.throws(() =>
      createLocalWorld({
        workspace: wt.worktree,
        agent,
        deployment: deploymentWith({ commands: { test: "rm -rf /" as unknown as string[] } }),
      }),
    );
  });

  it("EDGE-19: user.ask can no longer be answered from the model's own args", () => {
    const agent: AgentIR = {
      spec: "counterbalance-contract/v0.1",
      name: "ask",
      state: {},
      tools: [{ id: "user.ask", input: { type: "object" }, output: { type: "object" } }],
      permissions: { filesystem: { write_scopes: ["src/"] } },
    };
    for (const native of ["local.user_ask_auto", "local.user_ask"]) {
      assert.throws(
        () =>
          bindToolsFromDeployment(
            agent,
            { model: { transport: "recorded" }, bindings: { "user.ask": { native } } },
            { workspace: wt.worktree },
          ),
        /D14/,
      );
    }
    const local = createLocalCodingTools(
      createLocalWorld({ workspace: wt.worktree, agent, deployment: deploymentWith(), interactive: false }),
    );
    assert.equal(local["user.ask"], undefined);
    assert.equal(local["__local.user_ask_auto"], undefined);
  });
});
