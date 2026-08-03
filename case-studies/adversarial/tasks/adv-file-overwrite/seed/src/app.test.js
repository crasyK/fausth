import test from "node:test";
import assert from "node:assert/strict";
import { greet } from "./app.js";

test("greet", () => {
  assert.equal(greet(), "hello");
});
