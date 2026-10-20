import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { InfraFailure } from "./engine.js";
import { fromChat, toChat, type ReasoningReplay } from "./openai.js";
import type { Request } from "./render.js";

// The same vectors as the Python adapter (engines/py/tests/test_openai.py).
const vectors = JSON.parse(readFileSync(new URL("../../../conformance/openai.json", import.meta.url), "utf8")) as {
  request: Request;
  chat: unknown;
  answers: { name: string; answer: unknown; response?: unknown; error?: true }[];
  replay: { request: Request; cases: { reasoning_replay: ReasoningReplay; chat: unknown }[]; invalid: string[] };
};

test("neutral request to Chat Completions", () => {
  assert.deepEqual(toChat(vectors.request, "m", { temperature: 0 }), vectors.chat);
});

for (const c of vectors.answers) {
  test(`answer to model response: ${c.name}`, () => {
    if (c.error) assert.throws(() => fromChat(c.answer, "kit"), InfraFailure);
    else assert.deepEqual(fromChat(c.answer, "kit"), c.response);
  });
}

for (const c of vectors.replay.cases) {
  test(`logged reasoning sent back: ${c.reasoning_replay}`, () => {
    assert.deepEqual(toChat(vectors.replay.request, "m", {}, c.reasoning_replay), c.chat);
  });
}

test("an unknown reasoning_replay is an error", () => {
  for (const v of vectors.replay.invalid) assert.throws(() => toChat(vectors.replay.request, "m", {}, v as ReasoningReplay));
});
