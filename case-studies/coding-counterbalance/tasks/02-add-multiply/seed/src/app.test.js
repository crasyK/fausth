import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { multiply } from "./app.js";

describe("multiply", () => {
  it("multiplies", () => assert.equal(multiply(3, 4), 12));
});
