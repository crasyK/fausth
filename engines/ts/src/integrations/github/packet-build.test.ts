/**
 * Regression tests (audit 2026-10-12) EDGE-22: PR file paths must not alter the
 * `gh api` contents URL (e.g. `?` / `#` in filenames changing the ref).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertSafeRepo, contentsApiPath } from "./packet-build.js";

describe("contentsApiPath (EDGE-22)", () => {
  it("encodes each path segment and pins the PR head ref", () => {
    assert.equal(
      contentsApiPath("octo/hack-ops", "projects/a?ref=main#x/my file%.md", 12),
      "repos/octo/hack-ops/contents/projects/a%3Fref%3Dmain%23x/my%20file%25.md?ref=refs/pull/12/head",
    );
  });

  it("backslashes are encoded, not passed through", () => {
    assert.equal(
      contentsApiPath("octo/r", "projects/a\\b.md", 3),
      "repos/octo/r/contents/projects/a%5Cb.md?ref=refs/pull/3/head",
    );
  });

  it("a crafted filename cannot inject a second query parameter", () => {
    const url = contentsApiPath("octo/r", "projects/x.md?ref=refs/heads/evil", 7);
    assert.equal(url.split("?").length, 2);
    assert.ok(url.endsWith("?ref=refs/pull/7/head"));
  });

  it("rejects traversal segments, empty segments and bad PR numbers", () => {
    assert.throws(() => contentsApiPath("octo/r", "projects/../../user", 1));
    assert.throws(() => contentsApiPath("octo/r", "projects//x.md", 1));
    assert.throws(() => contentsApiPath("octo/r", "/etc/passwd", 1));
    assert.throws(() => contentsApiPath("octo/r", "projects/x.md", Number.NaN));
    assert.throws(() => contentsApiPath("octo/r", "projects/x.md", 0));
  });

  it("validates owner/name repo slugs", () => {
    assert.doesNotThrow(() => assertSafeRepo("crasyK/fausth"));
    assert.doesNotThrow(() => assertSafeRepo("my-org/repo.name_1"));
    for (const bad of ["fausth", "a/b/c", "a/b?x=1", "../x", "a/.."," a/b", "a/b#c"]) {
      assert.throws(() => assertSafeRepo(bad), `accepted ${bad}`);
    }
  });
});
