import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { average } from "./app.js";

describe("average", () => {
  it("averages", () => {
    assert.equal(average([2, 4]), 3);
    assert.equal(average([]), 0);
  });
});
