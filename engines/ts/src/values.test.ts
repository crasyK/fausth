import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { argumentText, canonical, excerpt, hash, sortedAsciiText } from "./values.js";

interface CanonicalCase { name: string; json: string; canonical?: string; hash?: string; error?: true }
interface ExcerptCase { s: string; n: number; out: string }
interface ArgumentTextCase { name: string; json: string; text: string; indented: string }
interface SortedAsciiCase { name: string; raw: string; text: string; indented: string }

const vectors = JSON.parse(
  readFileSync(new URL("../../../conformance/values.json", import.meta.url), "utf8"),
) as { canonical: CanonicalCase[]; excerpt: ExcerptCase[]; argument_text: ArgumentTextCase[]; sorted_ascii: SortedAsciiCase[] };

for (const v of vectors.canonical) {
  test(`canonical: ${v.name}`, async () => {
    if (v.error) {
      assert.throws(() => canonical(JSON.parse(v.json)));
      return;
    }
    const value: unknown = JSON.parse(v.json);
    assert.equal(canonical(value), v.canonical);
    if (v.hash) assert.equal(await hash(value), v.hash);
  });
}

for (const v of vectors.excerpt) {
  test(`excerpt: ${JSON.stringify(v.s)} ${v.n}`, () => {
    assert.equal(excerpt(v.s, v.n), v.out);
  });
}

for (const v of vectors.argument_text) {
  test(`argument text: ${v.name}`, () => {
    const value: unknown = JSON.parse(v.json);
    assert.equal(argumentText(value), v.text);
    assert.equal(argumentText(value, true), v.indented);
  });
}

for (const v of vectors.sorted_ascii) {
  test(`sorted_ascii: ${v.name}`, () => {
    assert.equal(sortedAsciiText(v.raw), v.text);
    assert.equal(sortedAsciiText(v.raw, true), v.indented);
  });
}

test("sorted_ascii needs JSON text with a canonical form (§1)", () => {
  for (const raw of ["NaN", "[Infinity]", "1e400", '"\\ud800"', "{", "", "[1,]"]) assert.throws(() => sortedAsciiText(raw), raw);
});

test("the argument text needs a canonical form (§1)", () => {
  assert.throws(() => argumentText(JSON.parse('"\\ud800"')));
  assert.throws(() => argumentText(Number.NaN));
});

test("canonical rejects values that are not JSON", () => {
  assert.throws(() => canonical(undefined));
  assert.throws(() => canonical(new Date(0)));
  assert.throws(() => canonical({ a: () => 1 }));
  assert.throws(() => canonical(1n));
});
