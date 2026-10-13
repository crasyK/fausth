import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { strLen } from "../src/app.js";

describe("strLen (held-out)", () => {
  it("returns 0 for nullish and empty", () => {
    assert.equal(strLen(undefined), 0);
    assert.equal(strLen(null), 0);
    assert.equal(strLen(""), 0);
  });
  it("keeps lengths of real strings", () => {
    assert.equal(strLen("hello"), 5);
    assert.equal(strLen("a b c"), 5);
  });
});
