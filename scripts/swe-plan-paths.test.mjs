/**
 * Unit tests for SWE plan path extraction.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractApprovedPathsFromEvents,
  extractPlanPaths,
  isTestPath,
} from "./swe-plan-paths.mjs";

describe("swe-plan-paths", () => {
  it("extracts source paths from plan text", () => {
    const paths = extractPlanPaths(
      "Edit django/conf/global_settings.py to set FILE_UPLOAD_PERMISSIONS.",
    );
    assert.deepEqual(paths, ["django/conf/global_settings.py"]);
  });

  it("skips test-only paths", () => {
    const paths = extractPlanPaths("Fix misc.py and add tests/test_misc.py");
    assert.deepEqual(paths, ["misc.py"]);
  });

  it("extracts from approve events", () => {
    const events = [
      JSON.stringify({
        tool: "user.approve",
        stage: "execute",
        args: { plan: "Patch src/flask/blueprints.py for the route bug." },
      }),
    ].join("\n");
    assert.deepEqual(extractApprovedPathsFromEvents(events), ["src/flask/blueprints.py"]);
  });

  it("skips nested test files (SCR-20)", () => {
    const paths = extractPlanPaths(
      "Fix astropy/modeling/separable.py; see astropy/modeling/tests/test_separable.py, " +
        "pkg/test_util.py, lib/foo_test.py, src/conftest.py and web/app.spec.ts.",
    );
    assert.deepEqual(paths, ["astropy/modeling/separable.py"]);
  });

  it("keeps library code under a nested singular test/ package", () => {
    assert.equal(isTestPath("django/test/utils.py"), false);
    assert.equal(isTestPath("django/test/testcases.py"), false);
    assert.equal(isTestPath("test/unit.py"), true);
    assert.equal(isTestPath("a/b/tests/helpers.py"), true);
  });
});
