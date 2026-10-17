import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { harnessErrors, readHarness } from "./harness.js";
import { canonical } from "./values.js";

const dir = new URL("../../../conformance/harnesses/", import.meta.url);
const files = (sub: string) => readdirSync(new URL(sub, dir)).filter((f) => !f.endsWith(".expected")).sort();
const read = (sub: string, f: string) => readFileSync(new URL(`${sub}/${f}`, dir), "utf8");

/** Read and check a harness the way an engine loads it; throws with the reasons if it is invalid. */
function load(text: string): unknown {
  const value = readHarness(text);
  canonical(value);
  const errors = harnessErrors(value);
  if (errors.length > 0) throw new Error(errors.join("; "));
  return value;
}

for (const f of files("valid")) {
  test(`valid: ${f}`, () => {
    const value = load(read("valid", f));
    assert.equal(canonical(value), read("valid", `${f}.expected`).trimEnd());
  });
}

for (const f of files("invalid")) {
  test(`invalid: ${f}`, () => {
    assert.throws(() => load(read("invalid", f)));
  });
}
