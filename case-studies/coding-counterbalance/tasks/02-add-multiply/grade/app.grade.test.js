import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { add, multiply } from "../src/app.js";

describe("multiply (held-out)", () => {
  it("multiplies signs, zero and fractions", () => {
    assert.equal(multiply(-6, 7), -42);
    assert.equal(multiply(0, 9), 0);
    assert.equal(multiply(2.5, 4), 10);
  });
  it("keeps add", () => assert.equal(add(2, 2), 4));
});
