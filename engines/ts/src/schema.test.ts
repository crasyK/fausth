// §8.1: why arguments fail (the cases the conformance fixture leaves out).
import assert from "node:assert/strict";
import { test } from "node:test";
import { argumentReasons } from "./schema.js";

const S = { type: "object", properties: { n: { type: "integer" }, e: { enum: [1, "a"] }, s: { type: "string", minLength: 2 } } };

test("booleans are not numbers and enum compares canonical forms", () => {
  assert.equal(argumentReasons(S, { n: true }), "n: must be an integer");
  assert.equal(argumentReasons(S, { e: true }), 'e: must be one of 1, "a"');
  assert.equal(argumentReasons(S, { e: 1.0, n: 2.0 }), "does not match the input schema");
});

test("code points and no schema", () => {
  assert.equal(argumentReasons(S, { s: "\u{1F642}" }), "s: at least 2 characters (it has 1)");
  assert.equal(argumentReasons(true, {}), "does not match the input schema");
});
