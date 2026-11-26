// The run loop's 0.6 parts that a replay fixture can't show: a host's own reasons (§8.1), `raw` (§14).
import { test } from "node:test";
import assert from "node:assert/strict";
import { run, type Host } from "./engine.js";
import type { Harness } from "./harness.js";
import type { Request } from "./render.js";
import type { Json } from "./values.js";

const harness: Harness = {
  spec: "harness/0.7", name: "n", prompt: "p",
  tools: { edit: { description: "Edit.", input: { type: "object", required: ["path"], properties: { path: { type: "string" } } } } },
  texts: { invalid_arguments: "Validation failed for tool \"{tool}\":\n{reasons}" },
};

function host(reasons?: Host["reasons"], call: unknown = { tool: "edit", args: { path: 3 } }): Host & { requests: Request[] } {
  const replies: unknown[] = [{ tool_calls: [call] }, { text: "Done." }];
  const requests: Request[] = [];
  let asked = false;
  return {
    requests,
    async user() { if (asked) return null; asked = true; return "Go."; },
    async model(request) { requests.push(request); return replies.shift(); },
    async call() { return { ok: true, result: "x" }; },
    interrupts: () => [],
    ...(reasons && { reasons }),
  };
}

const errorOf = (log: { entries: { type: string; error?: Json }[] }) => log.entries.find((e) => e.type === "tool_result")?.error;

test("without a host validator the reasons are the engine's (§8.1)", async () => {
  assert.equal(errorOf(await run(harness, host())), 'Validation failed for tool "edit":\npath: must be a string');
});

test("a host may give its own validator's reasons", async () => {
  const seen: [string, Json][] = [];
  const log = await run(harness, host((tool, args) => { seen.push([tool, args]); return "  - path: expected string"; }));
  assert.equal(errorOf(log), 'Validation failed for tool "edit":\n  - path: expected string');
  assert.deepEqual(seen, [["edit", { path: 3 }]]);
});

test("null from the host means the engine's reasons; anything else not a string is an infrastructure failure", async () => {
  assert.equal(errorOf(await run(harness, host(() => null))), 'Validation failed for tool "edit":\npath: must be a string');
  const log = await run(harness, host(() => 3 as unknown as string));
  assert.equal(log.entries.at(-1)?.reason, "infra_failure");
});

test("a raw text that is not the call's arguments breaks the interface (§14)", async () => {
  for (const call of [
    { tool: "edit", malformed: "{", raw: "{" }, // raw only beside args
    { tool: "edit", args: { path: "a" }, raw: { path: "a" } }, // raw is text
    { tool: "edit", args: { path: "a" }, raw: '{"path": "b"}' }, // and reads as args
    { tool: "edit", args: { path: "a" }, raw: '{"path": "a"' },
  ]) {
    const log = await run(harness, host(undefined, call));
    assert.equal(log.entries.at(-1)?.reason, "infra_failure", JSON.stringify(call));
  }
});

test("raw may differ from args in how it writes them", async () => {
  const call = { tool: "edit", args: { path: "a", n: 18446744073709551615 }, raw: '{ "n": 18446744073709551615, "path": "\\u0061" }' };
  const log = await run({ ...harness, argument_text: "sorted_ascii" }, host(undefined, call));
  assert.equal(log.entries.at(-1)?.reason, "stop");
  const assistant = log.entries.find((e) => e.type === "assistant") as unknown as { tool_calls: { args_text?: string }[] };
  assert.equal(assistant.tool_calls[0]?.args_text, '{"n":18446744073709551615,"path":"a"}');
});

// 0.7 (§14): `finish` and `failure` are strings when a response has them.
for (const extra of [{ finish: 1 }, { failure: null }]) {
  test(`a response whose ${Object.keys(extra)[0]} isn't a string breaks the interface`, async () => {
    const h = host();
    h.model = async () => ({ text: "x", ...extra });
    const log = await run(harness, h);
    assert.equal(log.entries.at(-1)!.reason, "infra_failure");
  });
}
