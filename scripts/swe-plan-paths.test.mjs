/**
 * Unit tests for SWE plan path extraction.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractApprovedPathsFromEvents,
  extractPlanPaths,
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
});
