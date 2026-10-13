import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clamp, identity } from "../src/app.js";

describe("clamp (held-out)", () => {
  it("is inclusive at both bounds", () => {
    assert.equal(clamp(0, 0, 10), 0);
    assert.equal(clamp(10, 0, 10), 10);
  });
  it("works for negative ranges and fractions", () => {
    assert.equal(clamp(-5, -10, -1), -5);
    assert.equal(clamp(-20, -10, -1), -10);
    assert.equal(clamp(3.5, 1, 2), 2);
  });
  it("keeps identity", () => assert.equal(identity("x"), "x"));
});
