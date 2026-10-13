import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { average, sum } from "../src/app.js";

describe("average (held-out)", () => {
  it("averages single, fractional and signed inputs", () => {
    assert.equal(average([5]), 5);
    assert.equal(average([1, 2, 3, 4]), 2.5);
    assert.equal(average([-2, 2]), 0);
  });
  it("is 0 for an empty list and keeps sum", () => {
    assert.equal(average([]), 0);
    assert.equal(sum([1, 2]), 3);
  });
});
