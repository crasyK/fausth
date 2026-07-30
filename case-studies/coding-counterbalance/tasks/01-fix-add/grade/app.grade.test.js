import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { add } from "../src/app.js";

describe("add", () => {
  it("adds", () => assert.equal(add(2, 3), 5));
});
