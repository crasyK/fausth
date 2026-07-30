import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clamp } from "./app.js";

describe("clamp", () => {
  it("clamps", () => {
    assert.equal(clamp(5, 0, 10), 5);
    assert.equal(clamp(-1, 0, 10), 0);
    assert.equal(clamp(99, 0, 10), 10);
  });
});
