import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fill, harnessErrors, harnessHash, readHarness, toolIds, type Harness } from "./harness.js";
import { canonical, hash } from "./values.js";

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

// 0.6 (§2, §8.2, §9, §15): the tool order, the hash that sees it, and the texts' placeholders.
const ordered = (spec: string) => readHarness(`spec: ${spec}
name: n
prompt: p
tools:
  zeta: { description: z, input: { type: object } }
  "10": { description: ten, input: { type: object } }
  Alpha: { description: a, input: { type: object } }
  "2": { description: two, input: { type: object } }
  "007": { description: seven, input: { type: object } }
`) as unknown as Harness;

test("tools come in member order: array-index ids first, the rest as declared", () => {
  assert.deepEqual(toolIds(ordered("harness/0.6")), ["2", "10", "zeta", "Alpha", "007"]);
});

test("a harness/0.5 file keeps 0.5's sorted order and hash", async () => {
  const h = ordered("harness/0.5");
  assert.deepEqual(toolIds(h), ["007", "10", "2", "Alpha", "zeta"]);
  assert.equal(await harnessHash(h), await hash(h));
});

test("harness_hash sees the tool order", async () => {
  const h = ordered("harness/0.6");
  assert.equal(await harnessHash(h), await hash([h as never, ["2", "10", "zeta", "Alpha", "007"]]));
  const swapped = { ...h, tools: { Alpha: h.tools!.Alpha!, zeta: h.tools!.zeta! } };
  const same = { ...h, tools: { zeta: h.tools!.zeta!, Alpha: h.tools!.Alpha! } };
  assert.equal(canonical(swapped), canonical(same));
  assert.notEqual(await harnessHash(swapped), await harnessHash(same));
});

test("fill replaces each placeholder once and leaves other braces", () => {
  assert.equal(fill('{tool}: {x} {"a": 1} {y z} {tool}', { tool: "{x}", x: "y" }), '{x}: y {"a": 1} {y z} {x}');
});
