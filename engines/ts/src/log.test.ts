import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Log, callId, view, type Scope } from "./log.js";
import type { Json } from "./values.js";

const vectors = JSON.parse(readFileSync(new URL("../../../conformance/log.json", import.meta.url), "utf8")) as {
  appends: { scope: Scope; type: string; members: { [k: string]: Json } }[];
  text: string;
  views: { scope: Scope; view: unknown[] }[];
  call_ids: [number, number, string][];
};

function replay(): Log {
  const log = new Log();
  for (const a of vectors.appends) log.append(a.scope, a.type, a.members);
  return log;
}

test("log text: one canonical line per entry, seq from 1, child entries carry depth and parent_call", () => {
  assert.equal(replay().text(), vectors.text);
});

for (const [i, v] of vectors.views.entries()) {
  test(`view ${i}: scope ${JSON.stringify(v.scope)}`, () => {
    assert.deepEqual(view(replay().entries, v.scope), v.view);
  });
}

test("call ids", () => {
  for (const [seq, index, id] of vectors.call_ids) assert.equal(callId(seq, index), id);
});

test("every entry type appears in the vectors", () => {
  const types = new Set(vectors.appends.map((a) => a.type));
  for (const t of ["run_start", "system", "user", "assistant", "hook", "tool_result", "interrupt", "harness_changed", "run_end"]) {
    assert.ok(types.has(t), t);
  }
});
