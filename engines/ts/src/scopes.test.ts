import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeScope, parseScope, scopeCoveredBy } from "./scopes.js";

describe("filesystem scopes (D7, spec-v0.3 §4.2)", () => {
  it("normalizes './', '//', trailing '/' and '.' segments", () => {
    assert.equal(normalizeScope("src"), "src");
    assert.equal(normalizeScope("src/"), "src");
    assert.equal(normalizeScope("./src"), "src");
    assert.equal(normalizeScope("src//lib/./"), "src/lib");
    assert.equal(normalizeScope("src/a/../b"), "src/b");
  });

  it("root is granted only by the explicit forms", () => {
    for (const r of [".", "./", "*", "**"]) assert.equal(normalizeScope(r), ".");
    assert.equal(parseScope("src/..").ok, false, "implicit root is rejected");
  });

  it("rejects absolute paths, escapes, drives, backslashes and globs", () => {
    assert.deepEqual(parseScope("/etc"), { ok: false, problem: "absolute" });
    assert.deepEqual(parseScope("src/../../etc"), { ok: false, problem: "escape" });
    assert.deepEqual(parseScope("../x"), { ok: false, problem: "escape" });
    assert.deepEqual(parseScope("C:/x"), { ok: false, problem: "drive" });
    assert.deepEqual(parseScope("src\\x"), { ok: false, problem: "backslash_or_nul" });
    assert.deepEqual(parseScope("src/*"), { ok: false, problem: "glob" });
    assert.deepEqual(parseScope(""), { ok: false, problem: "empty" });
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
});
