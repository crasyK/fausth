import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sum, total } from "./app.js";

describe("sum/total", () => {
  it("sums", () => {
    assert.equal(sum([1, 2, 3]), 6);
    assert.equal(total([1, 2, 3]), 6);
  });
});
