import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sumTo } from "./app.js";

describe("sumTo", () => {
  it("sums 1..n", () => assert.equal(sumTo(4), 10));
});
