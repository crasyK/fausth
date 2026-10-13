/**
 * Regression tests for isolated disposable workspaces (SCR-3, SCR-15).
 *
 * The agent's workspace must contain only the task seed: no task.yml, grade/,
 * oracle/ or gold data may be reachable — neither as files nor through git.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  WORKSPACE_MARKER,
  bootstrapWorkspace,
  checkRegisteredWorkspace,
  cleanupWorkspace,
} from "./lib/workspace.mjs";

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const cli = join(root, "scripts/disposable-worktree.mjs");
const require = createRequire(join(root, "engines/ts/package.json"));
const { parse: parseYaml } = require("yaml");

/** @param {string} dir @returns {string[]} relative file paths (excluding .git) */
function listFiles(dir) {
  /** @type {string[]} */
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === ".git") continue;
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** All blob contents reachable from the workspace's git object store. */
function allBlobs(ws) {
  const listing = git(ws, ["cat-file", "--batch-all-objects", "--batch-check"])
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(" "));
  return listing
    .filter(([, type]) => type === "blob")
    .map(([sha]) => git(ws, ["cat-file", "-p", sha]));
}

/** Strings that only exist in grading material for a task (never in its seed). */
function goldMarkers(taskDir) {
  const taskYmlText = readFileSync(join(taskDir, "task.yml"), "utf8");
  const yml = parseYaml(taskYmlText);
  /** @type {string[]} */
  const markers = [taskYmlText];
  if (yml.grade) markers.push(JSON.stringify(yml.grade));
  if (Array.isArray(yml.grade?.gold_actions) && yml.grade.gold_actions.length) {
    markers.push(JSON.stringify(yml.grade.gold_actions));
  }
  for (const sub of ["grade", "oracle", "expected"]) {
    const d = join(taskDir, sub);
    if (!existsSync(d)) continue;
    for (const f of listFiles(d)) {
      const text = readFileSync(join(d, f), "utf8");
      if (text.trim().length >= 16) markers.push(text);
    }
  }
  return markers;
}

const SAMPLE_TASKS = [
  "case-studies/coding-counterbalance/tasks/01-fix-add",
  "case-studies/coding-counterbalance/tasks/06-fix-null-guard",
  "case-studies/adversarial/tasks/adv-secret-exfil",
  "case-studies/tau-bench/tasks/retail-000",
];

describe("disposable workspace isolation", () => {
  let wsRoot = "";
  before(() => {
    wsRoot = mkdtempSync(join(tmpdir(), "fausth-ws-test-"));
  });
  after(() => {
    rmSync(wsRoot, { recursive: true, force: true });
  });

  for (const rel of SAMPLE_TASKS) {
    it(`workspace for ${rel} holds only the seed`, () => {
      const taskDir = join(root, rel);
      const yml = parseYaml(readFileSync(join(taskDir, "task.yml"), "utf8"));
      const seedDir = join(taskDir, yml.seed?.dir ?? yml.seed_dir ?? "seed");
      const out = execFileSync(
        process.execPath,
        [cli, "bootstrap", "--parent", root, "--seed", seedDir, "--root", wsRoot],
        { encoding: "utf8" },
      );
      const meta = JSON.parse(out);
      const ws = meta.worktree;
      try {
        // 1) File tree equals the seed exactly — nothing else is provisioned.
        assert.deepEqual(listFiles(ws), listFiles(seedDir));
        for (const f of listFiles(ws)) {
          assert.ok(!/(^|\/)task\.ya?ml$/.test(f), `task.yml leaked: ${f}`);
          assert.ok(!/(^|\/)(grade|oracle)(\/|$)/.test(f), `grader/oracle leaked: ${f}`);
        }
        // 2) The workspace is not a checkout of this repository.
        const common = resolve(ws, git(ws, ["rev-parse", "--git-common-dir"]).trim());
        const repoCommon = resolve(root, git(root, ["rev-parse", "--git-common-dir"]).trim());
        assert.notEqual(common, repoCommon);
        assert.ok(!common.startsWith(root + "/"), "git dir must live outside the repository");
        // 3) No gold/grader content reachable through files or git objects.
        const fileTexts = listFiles(ws).map((f) => readFileSync(join(ws, f), "utf8"));
        const blobs = allBlobs(ws);
        for (const marker of goldMarkers(taskDir)) {
          for (const t of fileTexts) assert.ok(!t.includes(marker), `gold marker in a file (${rel})`);
          for (const b of blobs) assert.ok(!b.includes(marker), `gold marker in git objects (${rel})`);
        }
        // 4) Every git blob is a seed file (object store holds nothing else).
        const seedTexts = new Set(listFiles(seedDir).map((f) => readFileSync(join(seedDir, f), "utf8")));
        for (const b of blobs) assert.ok(seedTexts.has(b), "unexpected blob in workspace repository");
        // 5) Registry marker lives outside the agent-visible workspace.
        assert.ok(!existsSync(join(ws, WORKSPACE_MARKER)));
        assert.ok(existsSync(join(meta.container, WORKSPACE_MARKER)));
      } finally {
        cleanupWorkspace({ worktree: ws, root: wsRoot });
      }
      assert.ok(!existsSync(meta.container), "cleanup removes the whole container");
    });
  }

  it("empty workspace (git_checkout seeders) is still an isolated linked worktree", () => {
    const meta = bootstrapWorkspace({ root: wsRoot });
    try {
      assert.deepEqual(listFiles(meta.worktree), []);
      const gitDir = resolve(meta.worktree, git(meta.worktree, ["rev-parse", "--git-dir"]).trim());
      assert.match(gitDir, /\/worktrees\/ws$/);
      assert.ok(gitDir.startsWith(meta.container));
    } finally {
      cleanupWorkspace({ worktree: meta.worktree, root: wsRoot });
    }
  });

  it("the engine accepts the workspace as a linked disposable worktree", () => {
    const meta = bootstrapWorkspace({ tinySeed: true, root: wsRoot });
    try {
      const probe = `import { validateLinkedWorktree } from ${JSON.stringify(
        join(root, "engines/ts/src/adapters/sandbox-path.ts"),
      )}; console.log(JSON.stringify(validateLinkedWorktree(${JSON.stringify(meta.worktree)})));`;
      const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], {
        cwd: join(root, "engines/ts"),
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout.trim()).isLinkedWorktree, true);
    } finally {
      cleanupWorkspace({ worktree: meta.worktree, root: wsRoot });
    }
  });

  it("refuses seeds containing symlinks", () => {
    const seed = mkdtempSync(join(tmpdir(), "fausth-seed-link-"));
    try {
      writeFileSync(join(seed, "a.txt"), "x\n");
      symlinkSync(join(root, "package.json"), join(seed, "escape.json"));
      assert.throws(() => bootstrapWorkspace({ seed, root: wsRoot }), /symlink/);
    } finally {
      rmSync(seed, { recursive: true, force: true });
    }
  });
});

describe("disposable workspace cleanup safety", () => {
  let wsRoot = "";
  before(() => {
    wsRoot = mkdtempSync(join(tmpdir(), "fausth-ws-clean-"));
  });
  after(() => {
    rmSync(wsRoot, { recursive: true, force: true });
  });

  it("cleanup without --worktree fails and deletes nothing (not even cwd)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "fausth-cwd-"));
    try {
      writeFileSync(join(cwd, "sentinel"), "keep\n");
      const r = spawnSync(process.execPath, [cli, "cleanup", "--parent", root], {
        cwd,
        encoding: "utf8",
      });
      assert.notEqual(r.status, 0);
      assert.ok(existsSync(join(cwd, "sentinel")), "cwd must survive");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("refuses to remove the repository or arbitrary directories", () => {
    assert.throws(() => cleanupWorkspace({ worktree: root, root: wsRoot }), /refusing/);
    const stray = mkdtempSync(join(wsRoot, "ws-"));
    mkdirSync(join(stray, "ws"));
    writeFileSync(join(stray, "ws", "keep"), "x\n");
    assert.throws(() => cleanupWorkspace({ worktree: join(stray, "ws"), root: wsRoot }), /refusing/);
    assert.ok(existsSync(join(stray, "ws", "keep")), "unregistered dir must survive");
    const r = spawnSync(process.execPath, [cli, "cleanup", "--worktree", root, "--root", wsRoot], {
      encoding: "utf8",
    });
    assert.notEqual(r.status, 0);
    assert.ok(existsSync(join(root, "package.json")), "repository must survive");
  });

  it("refuses workspaces outside the expected root", () => {
    const otherRoot = mkdtempSync(join(tmpdir(), "fausth-ws-other-"));
    try {
      const meta = bootstrapWorkspace({ tinySeed: true, root: otherRoot });
      assert.throws(() => cleanupWorkspace({ worktree: meta.worktree, root: wsRoot }), /refusing/);
      assert.ok(existsSync(meta.worktree));
      assert.equal(checkRegisteredWorkspace(meta.worktree, otherRoot).ok, true);
      cleanupWorkspace({ worktree: meta.worktree, root: otherRoot });
      assert.ok(!existsSync(meta.container));
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("refuses a symlink that points at a registered workspace", () => {
    const meta = bootstrapWorkspace({ tinySeed: true, root: wsRoot });
    const link = join(wsRoot, "ws-link");
    try {
      symlinkSync(meta.worktree, link);
      assert.throws(() => cleanupWorkspace({ worktree: link, root: wsRoot }), /refusing/);
      assert.ok(existsSync(meta.worktree));
    } finally {
      rmSync(link, { force: true });
      cleanupWorkspace({ worktree: meta.worktree, root: wsRoot });
    }
  });

  it("refuses a workspace root inside the repository", () => {
    assert.throws(
      () => bootstrapWorkspace({ tinySeed: true, root: join(root, "live", "ws-test") }),
      /outside the repository/,
    );
  });
});
