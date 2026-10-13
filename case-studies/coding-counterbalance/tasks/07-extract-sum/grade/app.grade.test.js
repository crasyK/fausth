import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sum, total } from "../src/app.js";

describe("sum/total (held-out)", () => {
  it("sum handles empty and mixed signs", () => {
    assert.equal(sum([]), 0);
    assert.equal(sum([-1, 1, 5]), 5);
  });
  it("total still works", () => {
    assert.equal(total([10, 20]), 30);
    assert.equal(total([]), 0);
  });
});
