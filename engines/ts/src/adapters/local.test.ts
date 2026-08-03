import { describe, it, before, after } from "node:test";
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
import {
  assertSafeRelativePath,
  resolveContainedPath,
  SandboxPathError,
  scopeCovered,
  validateLinkedWorktree,
} from "./sandbox-path.js";
import {
  createLocalCodingTools,
  createLocalWorld,
} from "./local.js";
import { resolveToolsFromDeployment, AdapterError } from "./registry.js";
import type { AgentIR, Deployment } from "../types.js";
import { loadAgentDir, loadDeployment } from "../load.js";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

function initBareRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe", windowsHide: true });
  execFileSync("git", ["config", "user.email", "fausth@test"], {
    cwd: dir,
    stdio: "pipe",
    windowsHide: true,
  });
  execFileSync("git", ["config", "user.name", "fausth"], {
    cwd: dir,
    stdio: "pipe",
    windowsHide: true,
  });
  writeFileSync(join(dir, "README.md"), "x\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "app.ts"), "export {}\n");
  writeFileSync(
    join(dir, "src", "app.test.js"),
    `import { describe, it } from "node:test";
import assert from "node:assert/strict";
describe("app", () => {
  it("loads", () => {
    assert.equal(1, 1);
  });
});
`,
  );
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "pipe", windowsHide: true });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe", windowsHide: true });
}

describe("sandbox-path", () => {
  it("rejects absolute, .., NUL, and .git", () => {
    assert.throws(() => assertSafeRelativePath("/etc/passwd"), SandboxPathError);
    assert.throws(() => assertSafeRelativePath("C:\\Windows"), SandboxPathError);
    assert.throws(() => assertSafeRelativePath("a/../b"), SandboxPathError);
    assert.throws(() => assertSafeRelativePath("a\0b"), SandboxPathError);
    assert.throws(() => assertSafeRelativePath(".git/config"), SandboxPathError);
    assert.equal(assertSafeRelativePath("src/app.ts"), "src/app.ts");
  });

  it("scopeCovered handles prefixes", () => {
    assert.equal(scopeCovered("src/a.ts", ["src/"]), true);
    assert.equal(scopeCovered("lib/a.ts", ["src/"]), false);
  });

  it("scopeCovered treats . as repo root", () => {
    assert.equal(scopeCovered("src", ["."]), true);
    assert.equal(scopeCovered("src/app.ts", ["."]), true);
    assert.equal(scopeCovered("README.md", ["."]), true);
    assert.equal(scopeCovered(".", ["."]), true);
  });
});

describe("local adapter worktree", () => {
  let primary = "";
  let worktree = "";

  before(() => {
    primary = mkdtempSync(join(tmpdir(), "fausth-primary-"));
    initBareRepo(primary);
    worktree = join(tmpdir(), `fausth-wt-${Date.now()}`);
    execFileSync("git", ["worktree", "add", "--detach", worktree], {
      cwd: primary,
      stdio: "pipe",
      windowsHide: true,
    });
  });

  after(() => {
    try {
      execFileSync("git", ["worktree", "remove", "--force", worktree], {
        cwd: primary,
        stdio: "pipe",
        windowsHide: true,
      });
    } catch {
      /* ignore */
    }
    rmSync(primary, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it("rejects primary checkout as workspace", () => {
    assert.throws(() => validateLinkedWorktree(primary), (e: unknown) => {
      assert.ok(e instanceof SandboxPathError);
      assert.equal(e.code, "worktree_invalid");
      return true;
    });
  });

  it("accepts linked worktree", () => {
    const v = validateLinkedWorktree(worktree);
    assert.equal(v.isLinkedWorktree, true);
    assert.ok(existsSync(v.root));
  });

  it("denies symlink escape when possible", () => {
    const outside = mkdtempSync(join(tmpdir(), "fausth-out-"));
    writeFileSync(join(outside, "secret.txt"), "nope");
    const linkPath = join(worktree, "src", "escape-link");
    try {
      symlinkSync(outside, linkPath, "junction");
    } catch {
      try {
        symlinkSync(outside, linkPath, "dir");
      } catch {
        rmSync(outside, { recursive: true, force: true });
        return; // platform may disallow symlinks without elevation
      }
    }
    assert.throws(
      () => resolveContainedPath(worktree, "src/escape-link/secret.txt"),
      SandboxPathError,
    );
    rmSync(outside, { recursive: true, force: true });
  });

  it("reads/writes/tests inside worktree with scopes", async () => {
    const agent = loadAgentDir(join(root, "examples/coding-counterbalance")).agent;
    const deployment = loadDeployment(
      join(root, "examples/coding-counterbalance/deployment.local-fixture.yml"),
    ) as Deployment;
    const world = createLocalWorld({ workspace: worktree, agent, deployment, interactive: false });
    const tools = createLocalCodingTools(world);

    const read = await tools["fs.read"]!({ path: "src/app.ts" }, { state: {} });
    assert.equal((read as { output: { found: number } }).output.found, 1);

    const write = await tools["fs.write_scoped"]!(
      { path: "src/app.ts", content: "export const ok = 1;\n" },
      { state: {} },
    );
    assert.equal((write as { output: { ok: number } }).output.ok, 1);
    assert.equal(readFileSync(join(worktree, "src/app.ts"), "utf8"), "export const ok = 1;\n");

    const denied = await tools["fs.write_scoped"]!(
      { path: "README.md", content: "hack" },
      { state: {} },
    );
    assert.equal((denied as { output: { out_of_scope: number } }).output.out_of_scope, 1);

    const readDenied = await tools["fs.read"]!({ path: "package.json" }, { state: {} });
    const readOut = (readDenied as { output: { found: number; error?: string; path: string } }).output;
    assert.equal(readOut.found, 0);
    assert.equal(readOut.error, "scope_denied");
    assert.equal(readOut.path, "package.json");

    const listed = await tools["fs.list"]!({ path: "src" }, { state: {} });
    const listOut = (listed as { output: { found: number; entries: string[] } }).output;
    assert.equal(listOut.found, 1);
    assert.ok(listOut.entries.includes("app.ts"));

    const shell = await tools["shell.run_allowlisted"]!({ cmd: "test" }, { state: {} });
    assert.equal((shell as { output: { exit_code: number } }).output.exit_code, 0);

    const approve = await tools["__local.user_approve_auto"]!(
      { plan: "Edit src/app.ts to fix the bug." },
      { state: {} },
    );
    assert.equal((approve as { output: { approved: number } }).output.approved, 1);
    const approveState = (approve as { state_transition?: { set?: Record<string, unknown> } })
      .state_transition?.set;
    assert.deepEqual(approveState?.allowed_write_paths, ["src/app.ts"]);
  });

  it("warns then denies off-plan writes when approved paths are set", async () => {
    const agent = loadAgentDir(join(root, "examples/coding-counterbalance")).agent;
    const deployment = loadDeployment(
      join(root, "examples/coding-counterbalance/deployment.local-fixture.yml"),
    ) as Deployment;
    const world = createLocalWorld({ workspace: worktree, agent, deployment, interactive: false });
    const tools = createLocalCodingTools(world);
    mkdirSync(join(worktree, ".fausth"), { recursive: true });
    writeFileSync(
      join(worktree, ".fausth/approved_paths.json"),
      JSON.stringify({ paths: ["src/app.ts"] }) + "\n",
    );

    const warn = await tools["fs.write_scoped"]!(
      { path: "src/other.ts", content: "off plan\n" },
      { state: { off_plan_writes: 0 } },
    );
    assert.equal((warn as { output: { ok: number; off_plan: number } }).output.ok, 1);
    assert.equal((warn as { output: { off_plan: number } }).output.off_plan, 1);

    const deny = await tools["fs.write_scoped"]!(
      { path: "src/other.ts", content: "off plan again\n" },
      { state: { off_plan_writes: 1 } },
    );
    assert.equal((deny as { output: { ok: number } }).output.ok, 0);
    assert.match(String((deny as { output: { error?: string } }).output.error ?? ""), /off_plan/);
  });

  it("tau.invoke stages request and returns result when tau command configured", async () => {
    const agent = loadAgentDir(join(root, "case-studies/tau-bench/harnesses/cb-tau-native")).agent;
    const deployment = loadDeployment(
      join(root, "case-studies/tau-bench/deployments/local-recorded.yml"),
    ) as Deployment;
    // Seed a minimal τ worktree
    mkdirSync(join(worktree, "data"), { recursive: true });
    mkdirSync(join(worktree, "tau"), { recursive: true });
    const seedData = join(root, "case-studies/tau-bench/world/data");
    for (const f of ["orders.json", "products.json", "users.json"]) {
      writeFileSync(join(worktree, "data", f), readFileSync(join(seedData, f)));
    }
    writeFileSync(
      join(worktree, "tau.mjs"),
      readFileSync(join(root, "case-studies/tau-bench/world/tau.mjs")),
    );
    const world = createLocalWorld({ workspace: worktree, agent, deployment, interactive: false });
    const tools = createLocalCodingTools(world);
    assert.ok(tools["tau.invoke"]);
    const missing = await tools["tau.invoke"]!({ kwargs: {} }, { state: {} });
    assert.equal((missing as { output: { ok: number } }).output.ok, 0);

    const inv = await tools["tau.invoke"]!(
      { tool: "list_all_product_types", kwargs: {} },
      { state: {} },
    );
    const out = (inv as { output: { ok: number; result: string; tool: string } }).output;
    assert.equal(out.ok, 1);
    assert.equal(out.tool, "list_all_product_types");
    assert.ok(out.result.length > 0);
    assert.ok(existsSync(join(worktree, "tau", "request.json")));
    assert.ok(existsSync(join(worktree, "tau", "outputs.log")));
    assert.match(readFileSync(join(worktree, "tau", "outputs.log"), "utf8"), /\S/);
    const actions = readFileSync(join(worktree, "tau", "actions.jsonl"), "utf8");
    assert.match(actions, /"result"/);
  });

  it("todo.complete fills a slot and sets open_todos when all filled", async () => {
    const agent = loadAgentDir(
      join(root, "case-studies/tau-bench/harnesses/cb-todo-delegate/agents/worker"),
    ).agent;
    const deployment = loadDeployment(
      join(root, "case-studies/tau-bench/deployments/local-recorded.yml"),
    ) as Deployment;
    mkdirSync(join(worktree, "tau"), { recursive: true });
    writeFileSync(
      join(worktree, "tau", "todos.json"),
      JSON.stringify(
        {
          version: 1,
          slots: [
            { id: "mutate_1_exchange_delivered_order_items", kind: "mutate", value: null, filled: false },
          ],
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      join(worktree, "tau", "actions.jsonl"),
      JSON.stringify({
        name: "exchange_delivered_order_items",
        kwargs: { order_id: "#W1" },
        result: '{"order_id":"#W1","status":"exchange requested"}',
      }) + "\n",
    );
    const world = createLocalWorld({ workspace: worktree, agent, deployment, interactive: false });
    const tools = createLocalCodingTools(world);
    assert.ok(tools["todo.complete"]);
    const bad = await tools["todo.complete"]!(
      { id: "nope", value: "x" },
      { state: {} },
    );
    assert.equal((bad as { output: { ok: number } }).output.ok, 0);

    const mismatch = await tools["todo.complete"]!(
      { id: "mutate_1_exchange_delivered_order_items", value: "wrong tool used" },
      { state: {} },
    );
    // First call with matching action should succeed — rewrite actions to empty to test deny.
    writeFileSync(join(worktree, "tau", "actions.jsonl"), "");
    const denied = await tools["todo.complete"]!(
      { id: "mutate_1_exchange_delivered_order_items", value: "no matching action" },
      { state: {} },
    );
    assert.equal((denied as { output: { ok: number; error?: string } }).output.ok, 0);
    assert.equal(
      (denied as { output: { error?: string } }).output.error,
      "mutate_tool_mismatch",
    );
    void mismatch;

    writeFileSync(
      join(worktree, "tau", "actions.jsonl"),
      JSON.stringify({
        name: "exchange_delivered_order_items",
        kwargs: { order_id: "#W1" },
        result: '{"order_id":"#W1","status":"exchange requested"}',
      }) + "\n",
    );
    const ok = await tools["todo.complete"]!(
      { id: "mutate_1_exchange_delivered_order_items", value: "exchanged #W1" },
      { state: {} },
    );
    const out = (ok as {
      output: { ok: number; all_filled: number; slots_filled: number };
      state_transition?: { set?: { open_todos?: number; slots_filled?: number } };
    });
    assert.equal(out.output.ok, 1);
    assert.equal(out.output.all_filled, 1);
    assert.equal(out.state_transition?.set?.open_todos, 0);
    const todos = JSON.parse(readFileSync(join(worktree, "tau", "todos.json"), "utf8"));
    assert.equal(todos.slots[0].value, "exchanged #W1");
    assert.equal(todos.slots[0].filled, true);
  });

  it("tau.invoke blocks off-plan mutations when todos declare other/no mutate slots", async () => {
    const agent = loadAgentDir(
      join(root, "case-studies/tau-bench/harnesses/cb-todo-delegate/agents/worker"),
    ).agent;
    const deployment = loadDeployment(
      join(root, "case-studies/tau-bench/deployments/local-recorded.yml"),
    ) as Deployment;
    mkdirSync(join(worktree, "data"), { recursive: true });
    mkdirSync(join(worktree, "tau"), { recursive: true });
    const seedData = join(root, "case-studies/tau-bench/world/data");
    for (const f of ["orders.json", "products.json", "users.json"]) {
      writeFileSync(join(worktree, "data", f), readFileSync(join(seedData, f)));
    }
    writeFileSync(
      join(worktree, "tau.mjs"),
      readFileSync(join(root, "case-studies/tau-bench/world/tau.mjs")),
    );
    writeFileSync(
      join(worktree, "tau", "todos.json"),
      JSON.stringify({
        version: 1,
        slots: [{ id: "resolve_1_request", kind: "resolve", value: null, filled: false }],
      }) + "\n",
    );
    // Shared suite worktree may retain prior actions.jsonl — start clean.
    const actionsPath = join(worktree, "tau", "actions.jsonl");
    if (existsSync(actionsPath)) rmSync(actionsPath);
    const world = createLocalWorld({ workspace: worktree, agent, deployment, interactive: false });
    const tools = createLocalCodingTools(world);
    const blocked = await tools["tau.invoke"]!(
      { tool: "cancel_pending_order", kwargs: { order_id: "#W1", reason: "no longer needed" } },
      { state: {} },
    );
    const out = (blocked as { output: { ok: number; error?: string }; state_transition?: { set?: { off_plan_mutations?: number } } });
    assert.equal(out.output.ok, 0);
    assert.equal(out.output.error, "off_plan_mutation");
    assert.equal(out.state_transition?.set?.off_plan_mutations, 1);
    assert.equal(existsSync(actionsPath), false);
  });

  it("todo.complete denies resolve when mutating actions exist; accepts or-tool mutate slots", async () => {
    const agent = loadAgentDir(
      join(root, "case-studies/tau-bench/harnesses/cb-todo-delegate/agents/worker"),
    ).agent;
    const deployment = loadDeployment(
      join(root, "case-studies/tau-bench/deployments/local-recorded.yml"),
    ) as Deployment;
    mkdirSync(join(worktree, "tau"), { recursive: true });
    writeFileSync(
      join(worktree, "tau", "todos.json"),
      JSON.stringify({
        version: 1,
        slots: [
          {
            id: "mutate_1_exchange_delivered_order_items_or_modify_pending_order_items",
            kind: "mutate",
            value: null,
            filled: false,
          },
          { id: "resolve_1_request", kind: "resolve", value: null, filled: false },
        ],
      }) + "\n",
    );
    writeFileSync(
      join(worktree, "tau", "actions.jsonl"),
      JSON.stringify({
        name: "modify_pending_order_items",
        kwargs: { order_id: "#W1" },
        result: '{"ok":true}',
      }) + "\n",
    );
    const world = createLocalWorld({ workspace: worktree, agent, deployment, interactive: false });
    const tools = createLocalCodingTools(world);

    const orOk = await tools["todo.complete"]!(
      {
        id: "mutate_1_exchange_delivered_order_items_or_modify_pending_order_items",
        value: "modified #W1",
      },
      { state: {} },
    );
    assert.equal((orOk as { output: { ok: number } }).output.ok, 1);

    const resolveDenied = await tools["todo.complete"]!(
      { id: "resolve_1_request", value: "cannot help" },
      { state: {} },
    );
    assert.equal((resolveDenied as { output: { ok: number; error?: string } }).output.ok, 0);
    assert.equal(
      (resolveDenied as { output: { error?: string } }).output.error,
      "resolve_requires_no_mutations",
    );
  });

  it("resolveToolsFromDeployment requires workspace for local.*", () => {
    const agent = loadAgentDir(join(root, "examples/coding-counterbalance")).agent;
    const deployment = loadDeployment(
      join(root, "examples/coding-counterbalance/deployment.local-fixture.yml"),
    ) as Deployment;
    assert.throws(
      () => resolveToolsFromDeployment(agent, deployment),
      (e: unknown) => e instanceof AdapterError,
    );
    const tools = resolveToolsFromDeployment(agent, deployment, { workspace: worktree });
    assert.ok(tools["fs.read"]);
  });

  it("rejects mixed local and sim bindings", () => {
    const agent = {
      tools: [
        { id: "fs.read", input: {}, output: {} },
        { id: "task.complete", input: {}, output: {} },
      ],
      state: {},
      permissions: { tools: ["fs.read", "task.complete"] },
    } as unknown as AgentIR;
    const deployment: Deployment = {
      model: { transport: "recorded" },
      bindings: {
        "fs.read": { native: "local.fs_read" },
        "task.complete": { native: "sim.task_complete" },
      },
    };
    assert.throws(() => resolveToolsFromDeployment(agent, deployment, { workspace: worktree }));
  });

  it("rejects primary checkout via resolveToolsFromDeployment", () => {
    const agent = loadAgentDir(join(root, "examples/coding-counterbalance")).agent;
    const deployment = loadDeployment(
      join(root, "examples/coding-counterbalance/deployment.local-fixture.yml"),
    ) as Deployment;
    assert.throws(() => resolveToolsFromDeployment(agent, deployment, { workspace: primary }));
  });
});
