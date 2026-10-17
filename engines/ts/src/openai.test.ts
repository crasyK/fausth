import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { InfraFailure } from "./engine.js";
import { fromChat, toChat } from "./openai.js";
import type { Request } from "./render.js";

// The same vectors as the Python adapter (engines/py/tests/test_openai.py).
const vectors = JSON.parse(readFileSync(new URL("../../../conformance/openai.json", import.meta.url), "utf8")) as {
  request: Request;
  chat: unknown;
  answers: { name: string; answer: unknown; response?: unknown; error?: true }[];
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
