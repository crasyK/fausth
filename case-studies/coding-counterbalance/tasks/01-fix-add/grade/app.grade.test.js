import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { add } from "../src/app.js";

describe("add (held-out)", () => {
  it("adds negatives, zero and fractions", () => {
    assert.equal(add(-7, 2), -5);
    assert.equal(add(-3, -4), -7);
    assert.equal(add(100, 0), 100);
    assert.equal(add(0.5, 0.25), 0.75);
  });
  it("is commutative", () => assert.equal(add(9, 1), add(1, 9)));
});
