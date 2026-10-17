import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonical, excerpt, hash } from "./values.js";

interface CanonicalCase { name: string; json: string; canonical?: string; hash?: string; error?: true }
interface ExcerptCase { s: string; n: number; out: string }

const vectors = JSON.parse(
  readFileSync(new URL("../../../conformance/values.json", import.meta.url), "utf8"),
) as { canonical: CanonicalCase[]; excerpt: ExcerptCase[] };

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

test("canonical rejects values that are not JSON", () => {
  assert.throws(() => canonical(undefined));
  assert.throws(() => canonical(new Date(0)));
  assert.throws(() => canonical({ a: () => 1 }));
  assert.throws(() => canonical(1n));
});
