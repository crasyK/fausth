// A binding that launches another Fausth run (§13.1): the harness it is handed, its own log and limits.
//
// The two conformance fixtures are the two runs of Hermes Agent's title after the turn: v06-stop-context is the main
// run, whose `stop` hook hands the title harness over in `with.harness` (its tools.jsonl records the binding's
// answers), and v06-stop-title-run is the launched one. Here the binding runs live, and each run must still give its
// own fixture's expected files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HostEnd, InfraFailure, run, type Host } from "./engine.js";
import { readHarness, type Harness } from "./harness.js";
import { finalText, handedHarness, harnessBinding, type Binding } from "./launch.js";
import type { Log } from "./log.js";
import type { Request } from "./render.js";
import { canonical, type Json } from "./values.js";

const fixtures = fileURLToPath(new URL("../../../conformance/fixtures/", import.meta.url));
const MAIN = `${fixtures}v06-stop-context/`;
const TITLE = `${fixtures}v06-stop-title-run/`;
const WRAPPER = /<system-reminder>[\s\S]*?<\/system-reminder>\s*/g;
const ALLOW = { ok: true, result: { decision: "allow" } };

type Line = { [k: string]: Json };
const lines = (path: string): Line[] =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Line) : [];

/** Answers the model from `replies` (an Error is thrown), bound ids from `live`, other ids from `tools`. */
function scripted(replies: unknown[], live: Record<string, Binding> = {}, tools: Line[] = [], users: string[] = []): Host & { requests: Request[] } {
  const requests: Request[] = [];
  return {
    requests,
    async user() { return users.shift() ?? null; },
    async model(request) {
      requests.push(request);
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply;
    },
    async call(id, input) {
      if (Object.hasOwn(live, id)) return live[id]!(input);
      const { id: given, ...answer } = tools.shift()!;
      assert.equal(given, id);
      return answer;
    },
    interrupts: () => [],
  };
}

const fromFixture = (dir: string, live: Record<string, Binding>) => scripted(
  lines(`${dir}model.jsonl`), live, lines(`${dir}tools.jsonl`).filter((t) => !Object.hasOwn(live, t.id as string)),
  lines(`${dir}user.jsonl`).map((u) => u.text as string));
const harnessOf = (dir: string) => readHarness(readFileSync(`${dir}harness.json`, "utf8")) as unknown as Harness;

/** The opening user message without the host's wrappers, cut to `with.max_chars` code points (Hermes: 1000). */
function titleTask(input: Json): string {
  const i = input as { context: { role: string; text: string }[]; with: { max_chars: number } };
  const opening = i.context.find((m) => m.role === "user")!.text;
  return Array.from(opening.replace(WRAPPER, "")).slice(0, i.with.max_chars).join("");
}

test("a stop handler launches the harness its hook hands it, and both logs stay apart", async () => {
  const saved: { [k: string]: Json } = {};
  const logs: Log[] = [];
  const titleHost = fromFixture(TITLE, {
    save_title: async (input) => { Object.assign(saved, JSON.parse((input as { message: string }).message)); return ALLOW; },
  });
  const launch = harnessBinding(titleHost, titleTask, { answer: () => ALLOW, onLog: (log) => logs.push(log) });
  const main = await run(harnessOf(MAIN), fromFixture(MAIN, {
    make_title: async (input) => ("title" in saved ? ALLOW : launch(input)),
  }));

  // The caller's file holds the title harness (one resolved document, §2), and the binding runs that one.
  assert.equal(canonical((harnessOf(MAIN).hooks![1]!.with as { harness: Json }).harness), canonical(harnessOf(TITLE) as unknown as Json));
  // The caller's log holds only the binding's answers; the launched run has its own log and requests.
  assert.equal(main.text(), readFileSync(`${MAIN}expected.log.jsonl`, "utf8"));
  assert.equal(logs.length, 1); // the second turn's stop finds the title saved and launches nothing
  assert.equal(logs[0]!.text(), readFileSync(`${TITLE}expected.log.jsonl`, "utf8"));
  assert.equal(titleHost.requests.map((r) => `${canonical(r as unknown as Json)}\n`).join(""), readFileSync(`${TITLE}expected.requests.jsonl`, "utf8"));
  assert.deepEqual(saved, { title: "Empty input in parser.py parse" });
  // No hook of the caller runs in the launched run (§13.1): its only hook is its own.
  assert.deepEqual(logs[0]!.entries.filter((e) => e.type === "hook").map((e) => e.hook), ["save"]);
});

const SUMMARIZER: Harness = { spec: "harness/0.6", name: "summarizer", prompt: "Summarize the text in one line." };
const ORCHESTRATOR: Harness = {
  spec: "harness/0.6", name: "orchestrator", prompt: "Delegate.",
  tools: { run_agent: { description: "Run a sub-agent harness on a task.", input: {
    type: "object", required: ["harness", "task"], additionalProperties: false,
    properties: { harness: { type: "object" }, task: { type: "string" } } } } },
  limits: { max_steps: 2 },
};

/** The orchestrator's model writes a sub-agent harness at runtime and hands it to `run_agent`. */
const orchestratorHost = (binding: Binding, harness: unknown = SUMMARIZER) => scripted(
  [{ tool_calls: [{ tool: "run_agent", args: { harness, task: "A long text." } }] }, { text: "Done." }],
  { run_agent: binding }, [], ["Go."]);
const taskArgument = (input: Json) => (input as { task: string }).task;
const resultOf = (log: Log) => {
  const e = log.entries.find((x) => x.type === "tool_result")!;
  return Object.fromEntries(["ok", "result", "error"].filter((k) => k in e).map((k) => [k, e[k]]));
};

test("a tool launches the harness the model wrote and answers with its final text", async () => {
  const launched = scripted([{ text: "Short.", reasoning: "r" }]);
  const log = await run(ORCHESTRATOR, orchestratorHost(harnessBinding(launched, taskArgument)));
  assert.deepEqual(resultOf(log), { ok: true, result: "Short." });
  assert.deepEqual(launched.requests[0], { system: "Summarize the text in one line.", tools: [], messages: [{ role: "user", text: "A long text." }] });
  // Its steps and limits are its own: the orchestrator's max_steps 2 still allows its own two requests, and
  // nothing of the launched run is in its log.
  assert.equal(log.entries.at(-1)?.reason, "stop");
  assert.equal(log.entries.filter((e) => e.type === "run_start").length, 1);
  assert.ok(log.entries.slice(1).every((e) => e.depth === undefined));
});

test("a handed harness that can't run is world feedback for a tool", async () => {
  for (const harness of [
    { ...SUMMARIZER, spec: "harness/0.5" }, // not valid
    { ...SUMMARIZER, tools: { shell: { description: "Run a command.", input: { type: "object" } } } }, // not bound
  ]) {
    const launched = scripted([]);
    const binding = harnessBinding(launched, taskArgument, { binds: (id) => id === "read" });
    const log = await run(ORCHESTRATOR, orchestratorHost(binding, harness));
    assert.deepEqual(resultOf(log), { ok: false, error: "child harness is not valid" });
    assert.equal(launched.requests.length, 0);
    assert.equal(log.entries.at(-1)?.reason, "stop");
  }
});

test("a handed harness that can't run fails a handler's hook", async () => {
  const caller: Harness = { spec: "harness/0.6", name: "c", prompt: "p", handlers: { make_title: {} },
    hooks: [{ id: "title", on: "stop", run: "make_title", with: { harness: { name: "x" } } }] };
  const log = await run(caller, scripted([{ text: "Hi." }], { make_title: harnessBinding(scripted([]), () => "t") }, [], ["Hello."]));
  assert.deepEqual(log.entries.filter((e) => e.type === "hook").map((e) => e.decision), ["failed"]);
  assert.equal(log.entries.at(-1)?.reason, "infra_failure"); // on_failure: end (§5.4)
});

test("a launched run that ends without an answer is the binding's infrastructure failure", async () => {
  for (const reply of [() => new InfraFailure("down"), () => new HostEnd("left"), () => ({ text: 3 })]) {
    const logs: Log[] = [];
    const binding = harnessBinding(scripted([reply()]), taskArgument, { onLog: (log) => logs.push(log) });
    await assert.rejects(binding({ harness: SUMMARIZER as unknown as Json, task: "t" }), InfraFailure);
    assert.ok(["infra_failure", "host_end"].includes(logs[0]!.entries.at(-1)!.reason as string)); // the host still gets its log
    // In the caller: a tool's binding without an answer ends the run (§3.3) ...
    const log = await run(ORCHESTRATOR, orchestratorHost(harnessBinding(scripted([reply()]), taskArgument)));
    assert.equal(log.entries.at(-1)?.reason, "infra_failure");
    // ... and fails a handler's hook, which on_failure: skip lets pass.
    const caller: Harness = { spec: "harness/0.6", name: "c", prompt: "p", handlers: { make_title: {} },
      hooks: [{ id: "title", on: "stop", run: "make_title", on_failure: "skip", with: { harness: SUMMARIZER as unknown as Json } }] };
    const skipped = await run(caller, scripted([{ text: "Hi." }], { make_title: harnessBinding(scripted([reply()]), () => "t") }, [], ["Hello."]));
    assert.deepEqual(skipped.entries.filter((e) => e.type === "hook").map((e) => e.decision), ["failed"]);
    assert.equal(skipped.entries.at(-1)?.reason, "stop");
  }
});

test("a task that is not a string is an infrastructure failure", async () => {
  await assert.rejects(harnessBinding(scripted([]), () => null)({ harness: SUMMARIZER as unknown as Json }), InfraFailure);
});

test("the handed harness and the final text", async () => {
  assert.equal(handedHarness({ event: "stop", with: { harness: 1 }, harness: 2 }), 1);
  assert.equal(handedHarness({ harness: 2 }), 2);
  assert.equal(handedHarness({ event: "stop", with: {} }), undefined);
  assert.equal(finalText(await run(SUMMARIZER, scripted([{ text: "One." }], {}, [], ["a"]))), "One.");
  assert.equal(finalText(await run(SUMMARIZER, scripted([new InfraFailure("x")], {}, [], ["a"]))), "");
});
