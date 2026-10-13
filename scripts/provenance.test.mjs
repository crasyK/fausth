/** CASE-14: provenance tracks the exact code state; live evidence needs a clean tree. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  evidenceGate,
  gitCodeState,
  hashFiles,
  hashTree,
  runtimeVersions,
} from "./lib/provenance.mjs";

function git(cwd, ...args) {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

describe("git code state", () => {
  let repo = "";
  before(() => {
    repo = mkdtempSync(join(tmpdir(), "fausth-prov-"));
    git(repo, "init", "-q");
    mkdirSync(join(repo, "h"));
    writeFileSync(join(repo, "h", "agent.yml"), "name: a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
  });
  after(() => rmSync(repo, { recursive: true, force: true }));

  it("detects dirty trees and hashes the diff (same commit, different code ⇒ different hash)", () => {
    const clean = gitCodeState(repo);
    assert.equal(clean.dirty, false);
    assert.equal(clean.diff_sha256, null);
    assert.match(clean.commit_sha, /^[0-9a-f]{40}$/);

    writeFileSync(join(repo, "h", "agent.yml"), "name: b\n");
    const d1 = gitCodeState(repo);
    assert.equal(d1.dirty, true);
    assert.equal(d1.commit_sha, clean.commit_sha);
    assert.deepEqual(d1.dirty_paths, ["h/agent.yml"]);

    writeFileSync(join(repo, "h", "agent.yml"), "name: c\n");
    const d2 = gitCodeState(repo);
    assert.notEqual(d2.diff_sha256, d1.diff_sha256, "diff hash tracks content");

    writeFileSync(join(repo, "untracked.mjs"), "x\n");
    const d3 = gitCodeState(repo);
    assert.ok(d3.dirty_paths.includes("untracked.mjs"));
    assert.notEqual(d3.diff_sha256, d2.diff_sha256, "untracked files count");
  });

  it("hashes files and trees", () => {
    const files = hashFiles(repo, ["h"]);
    assert.deepEqual(Object.keys(files), ["h/agent.yml"]);
    const t1 = hashTree(repo, "h");
    writeFileSync(join(repo, "h", "extra.md"), "y\n");
    assert.notEqual(hashTree(repo, "h"), t1);
    assert.equal(hashTree(repo, "missing"), null);
  });

  it("records runtime versions", () => {
    const v = runtimeVersions(repo);
    assert.equal(v.node, process.version);
    assert.ok("python" in v && "git" in v);
  });

  it("reports unknown state outside a repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "fausth-norepo-"));
    try {
      const s = gitCodeState(dir);
      assert.equal(s.commit_sha, null);
      assert.equal(s.dirty, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("evidence gate", () => {
  it("refuses live runs on a dirty tree unless allowed (then non-evidence)", () => {
    assert.deepEqual(evidenceGate({ mode: "live", dirty: false }).evidence, true);
    const refused = evidenceGate({ mode: "live", dirty: true });
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /--allow-dirty/);
    const allowed = evidenceGate({ mode: "live", dirty: true, allowDirty: true });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.evidence, false);
    assert.equal(evidenceGate({ mode: "live", dirty: null }).ok, false);
    assert.equal(evidenceGate({ mode: "live", dirty: false, smoke: true }).evidence, false);
    const rec = evidenceGate({ mode: "recorded", dirty: true });
    assert.equal(rec.ok, true);
    assert.equal(rec.evidence, false);
  });
});
