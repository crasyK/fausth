import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeScope, parseScope, scopeCoveredBy } from "./scopes.js";
import { normalizeScope as hostNormalizeScope, scopeCovered as hostScopeCovered } from "./adapters/sandbox-path.js";

describe("filesystem scopes (D7, spec-v0.3 §4.2)", () => {
  it("normalizes './', '//', trailing '/', '.' segments, backslashes and surrounding blanks", () => {
    assert.equal(normalizeScope("src"), "src");
    assert.equal(normalizeScope("src/"), "src");
    assert.equal(normalizeScope("./src"), "src");
    assert.equal(normalizeScope("src//lib/./"), "src/lib");
    assert.equal(normalizeScope("src/a/../b"), "src/b");
    assert.equal(normalizeScope("src\\lib"), "src/lib");
    assert.equal(normalizeScope(" src "), "src");
  });

  it("root is granted only by the explicit forms", () => {
    for (const r of [".", "./", "*", "**"]) assert.equal(normalizeScope(r), ".");
    assert.deepEqual(parseScope("src/.."), { ok: false, problem: "implicit_root" });
  });

  it("rejects absolute paths, escapes, .git, empty and globs", () => {
    assert.deepEqual(parseScope("/etc"), { ok: false, problem: "absolute" });
    assert.deepEqual(parseScope("C:/x"), { ok: false, problem: "absolute" });
    assert.deepEqual(parseScope("src/../../etc"), { ok: false, problem: "escape" });
    assert.deepEqual(parseScope("../x"), { ok: false, problem: "escape" });
    assert.deepEqual(parseScope(".git/hooks"), { ok: false, problem: "git" });
    assert.deepEqual(parseScope("src/*"), { ok: false, problem: "glob" });
    assert.equal(parseScope("").ok, false);
  });

  it("containment is segment-wise, 'src' ≡ 'src/'", () => {
    assert.equal(scopeCoveredBy("src/a.ts", ["src"]), true);
    assert.equal(scopeCoveredBy("src/a.ts", ["src/"]), true);
    assert.equal(scopeCoveredBy("src", ["src/"]), true);
    assert.equal(scopeCoveredBy("srcx/a.ts", ["src"]), false, "string prefix is not containment");
    assert.equal(scopeCoveredBy("src/../../etc", ["src"]), false, "escape never covered");
    assert.equal(scopeCoveredBy("src/../lib", ["src"]), false, "normalizes to lib");
  });

  it("root covers everything; only root covers root", () => {
    assert.equal(scopeCoveredBy("anything/deep", ["."]), true);
    assert.equal(scopeCoveredBy(".", ["src"]), false);
    assert.equal(scopeCoveredBy("**", ["*"]), true);
  });

  it("agrees with the host adapters' normalization (one definition for engine and hosts)", () => {
    const corpus = ["src", "src/", "./src//", "src/a/../b", "src\\lib", ".", "**", "a/b/c"];
    for (const raw of corpus) {
      assert.equal(normalizeScope(raw), hostNormalizeScope(raw), raw);
    }
    const children = ["src/a.ts", "srcx", "lib", "src", "a/b/c/d"];
    for (const child of children) {
      assert.equal(scopeCoveredBy(child, ["src", "a/b"]), hostScopeCovered(child, ["src", "a/b"]), child);
    }
  });
});
