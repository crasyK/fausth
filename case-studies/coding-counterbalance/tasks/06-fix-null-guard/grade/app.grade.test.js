import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { strLen } from "../src/app.js";

describe("strLen", () => {
  it("handles nullish", () => {
    assert.equal(strLen(null), 0);
    assert.equal(strLen(undefined), 0);
    assert.equal(strLen("ab"), 2);
  });
});
