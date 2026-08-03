import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractPlanPaths } from "./plan-paths.js";

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
});
