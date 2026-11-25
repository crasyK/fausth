// The run loop's 0.6 parts that a replay fixture can't show: a host's own reasons (§8.1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { run, type Host } from "./engine.js";
import type { Harness } from "./harness.js";
import type { Request } from "./render.js";
import type { Json } from "./values.js";

const harness: Harness = {
  spec: "harness/0.6", name: "n", prompt: "p",
  tools: { edit: { description: "Edit.", input: { type: "object", required: ["path"], properties: { path: { type: "string" } } } } },
  texts: { invalid_arguments: "Validation failed for tool \"{tool}\":\n{reasons}" },
};

function host(reasons?: Host["reasons"]): Host & { requests: Request[] } {
  const replies: unknown[] = [{ tool_calls: [{ tool: "edit", args: { path: 3 } }] }, { text: "Done." }];
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
