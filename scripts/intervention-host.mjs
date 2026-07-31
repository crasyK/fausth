#!/usr/bin/env node
/**
 * Host runner demo: cron-style intervention budget for a Socratic-pair-like harness.
 *
 * Triggers and budgets are declared on the harness; this host interprets them.
 * Cross-run counters for window:host_day would persist beside this script.
 *
 * Usage:
 *   node --import tsx scripts/intervention-host.mjs [--activations N]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FaustRuntime, eventsToJsonl } from "../engines/ts/src/runtime.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "conformance/fixtures/cb-budget-exceeded");

const args = process.argv.slice(2);
const actIdx = args.indexOf("--activations");
const hostActivations = actIdx >= 0 ? Number(args[actIdx + 1] ?? 2) : 2;

const agent = JSON.parse(readFileSync(join(fixture, "agent.json"), "utf8"));
const budget = agent.counterbalance?.intervention_budget ?? { max_activations: 1, window: "run" };
const triggers = agent.counterbalance?.triggers ?? [];

console.log("triggers (host interprets):", JSON.stringify(triggers));
console.log("budget:", JSON.stringify(budget));

const allEvents = [];
for (let a = 0; a < hostActivations; a++) {
  const model = [
    { type: "tool", name: "noop.ping", args: {} },
    { type: "tool", name: "noop.ping", args: {} },
  ];
  const tools = [
    { call_seq: 1, tool: "noop.ping", args: {}, result: { ok: 1 } },
    { call_seq: 2, tool: "noop.ping", args: {}, result: { ok: 1 } },
  ];
  let pi = 0;
  const rt = new FaustRuntime({
    agent: structuredClone(agent),
    propose: async () => (pi >= model.length ? { type: "stop" } : model[pi++]),
    tools: {},
    recordedToolResults: tools,
  });
  await rt.runLoop();
  allEvents.push(...rt.events.map((e) => ({ ...e, host_activation: a + 1 })));
  const hit = rt.events.some((e) => e.reason === "budget_exceeded");
  console.log(`activation ${a + 1}: events=${rt.events.length} budget_exceeded=${hit}`);
}

const outDir = join(root, "live/reports");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "intervention-host.jsonl");
writeFileSync(outPath, allEvents.map((e) => JSON.stringify(e)).join("\n") + "\n");
console.log("wrote", outPath);
