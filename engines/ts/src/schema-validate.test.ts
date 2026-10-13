import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { schemaCacheSize, schemaCompiles, validateAgainstSchema } from "./schema-validate.js";

describe("tool schema validation (CORE-10, spec-v0.3 §2.3)", () => {
  it("compiles each distinct schema once (bounded cache)", () => {
    const schema = { type: "object", properties: { n: { type: "integer" } } };
    validateAgainstSchema(schema, { n: 1 });
    const size = schemaCacheSize();
    for (let i = 0; i < 50; i++) {
      assert.equal(validateAgainstSchema({ ...schema }, { n: i }).ok, true);
    }
    assert.equal(schemaCacheSize(), size);
  });

  it("a schema with $id can be used repeatedly (used to throw on the 2nd compile)", () => {
    const a = { $id: "https://example.test/tool.json", type: "object", properties: { x: { type: "string" } } };
    const b = { $id: "https://example.test/tool.json", type: "object", properties: { y: { type: "string" } } };
    assert.equal(validateAgainstSchema(a, { x: "1" }).ok, true);
    assert.equal(validateAgainstSchema(a, { x: "2" }).ok, true);
    assert.equal(validateAgainstSchema(b, { y: "3" }).ok, true, "same $id, different schema");
  });

  it("an uncompilable schema is reported, never thrown", () => {
    const bad = { type: "object", properties: { x: { $ref: "#/does/not/exist" } } };
    const r = validateAgainstSchema(bad, { x: 1 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.compileError, true);
    assert.notEqual(schemaCompiles(bad), null);
  });

  it("defaults: missing type = object, missing additionalProperties = false", () => {
    assert.equal(validateAgainstSchema({ properties: { a: { type: "integer" } } }, { a: 1, b: 2 }).ok, false);
    assert.equal(validateAgainstSchema({ properties: { a: { type: "integer" } } }, "x").ok, false);
  });

  it("format is an annotation only (same as the Python engine)", () => {
    const s = { type: "object", properties: { when: { type: "string", format: "date-time" } } };
    assert.equal(validateAgainstSchema(s, { when: "not a date" }).ok, true);
  });
});
