import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractPlanPaths, isTestPath } from "./plan-paths.js";

describe("plan-paths", () => {
  it("extracts django global settings path", () => {
    assert.deepEqual(
      extractPlanPaths("Edit django/conf/global_settings.py for upload perms."),
      ["django/conf/global_settings.py"],
    );
  });

  it("ignores test paths", () => {
    assert.deepEqual(extractPlanPaths("Update pylint/checkers/misc.py only"), [
      "pylint/checkers/misc.py",
    ]);
  });

  it("excludes nested test paths (same rule as scripts/swe-plan-paths.mjs)", () => {
    assert.deepEqual(
      extractPlanPaths(
        "Fix pkg/core.py; update pkg/tests/test_core.py and src/app.test.ts, " +
          "src/app.spec.js, pkg/sub/conftest.py, pkg/x_test.py, test/helpers.py, " +
          "and keep django/test/utils.py",
      ),
      ["django/test/utils.py", "pkg/core.py"],
    );
    assert.equal(isTestPath("pkg/tests/test_core.py"), true);
    assert.equal(isTestPath("a/b/tests/fixtures/data.json"), true);
    assert.equal(isTestPath("test/helpers.py"), true);
    assert.equal(isTestPath("pkg/test_x.pyi"), true);
    assert.equal(isTestPath("django/test/utils.py"), false);
    assert.equal(isTestPath("src/contest.py"), false);
  });

  it("drops traversal, absolute and .git paths", () => {
    assert.deepEqual(extractPlanPaths("Edit src/a.py and src/../etc/x.py and pkg/.git/config.json"), ["src/a.py"]);
  });
});
