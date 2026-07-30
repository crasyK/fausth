import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { greet } from "../src/app.js";

describe("greet", () => {
  it("greets", () => assert.equal(greet("Ada"), "hi Ada"));
});
