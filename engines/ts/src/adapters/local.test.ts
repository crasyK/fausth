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

    const approve = await tools["__local.user_approve_auto"]!({}, { state: {} });
    assert.equal((approve as { output: { approved: number } }).output.approved, 1);
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
