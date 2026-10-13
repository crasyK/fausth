import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sumTo } from "../src/app.js";

describe("sumTo (held-out)", () => {
  it("includes n at the boundaries", () => {
    assert.equal(sumTo(1), 1);
    assert.equal(sumTo(0), 0);
    assert.equal(sumTo(10), 55);
    assert.equal(sumTo(100), 5050);
  });
});
