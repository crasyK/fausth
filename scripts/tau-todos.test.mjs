/**
 * SCR-14: nothing the agent sees (todos, prompts) and no host decision during a
 * run may be derived from grading data (gold_actions / outputs).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  backfillMutateSlotsFromActions,
  initialTodoPlan,
  readTauTodos,
  writeTauFinalizePrompt,
  writeTauTodos,
} from "./lib/tau-todos.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const YAML = createRequire(join(root, "engines/ts/package.json"))("yaml");

/** Host artifacts for a task: todo plan + finalize prompt (no worker activity). */
function hostArtifacts(taskDir, ws) {
  writeTauTodos(ws, initialTodoPlan());
  const out = join(ws, "..", "finalize.md");
  writeTauFinalizePrompt(join(taskDir, "prompt.md"), ws, out);
  return {
    todos: readFileSync(join(ws, "tau", "todos.json"), "utf8"),
    finalize: readFileSync(out, "utf8").replace(readFileSync(join(taskDir, "prompt.md"), "utf8"), ""),
  };
}

function goldValues(taskDir) {
  const yml = YAML.parse(readFileSync(join(taskDir, "task.yml"), "utf8"));
  const vals = new Set();
  for (const g of yml.grade?.gold_actions ?? []) {
    vals.add(String(g.name ?? g.tool));
    for (const v of Object.values(g.kwargs ?? {})) {
      for (const x of [v].flat()) if (String(x).length >= 3) vals.add(String(x));
    }
  }
  for (const o of yml.grade?.outputs ?? []) vals.add(String(o));
  return [...vals];
}

describe("τ todo-delegate host plumbing is gold-free", () => {
  let tmp = "";
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "fausth-tau-todo-"));
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it("host artifacts are identical across tasks with different gold", () => {
    const tasks = ["retail-000", "retail-019", "retail-004"].map((t) =>
      join(root, "case-studies/tau-bench/tasks", t),
    );
    const outs = tasks.map((t, i) => {
      const ws = join(tmp, `ws${i}`);
      mkdirSync(ws, { recursive: true });
      return hostArtifacts(t, ws);
    });
    for (const o of outs.slice(1)) {
      assert.equal(o.todos, outs[0].todos, "todo plan must not depend on the task's gold");
      assert.equal(o.finalize, outs[0].finalize, "finalize brief must not depend on gold");
    }
    for (const [i, t] of tasks.entries()) {
      for (const g of goldValues(t)) {
        assert.ok(!outs[i].todos.includes(g), `gold value ${g} leaked into todos`);
        assert.ok(!outs[i].finalize.includes(g), `gold value ${g} leaked into finalize brief`);
      }
    }
  });

  it("never fills report slots from gold outputs, only mirrors the worker's own mutations", () => {
    const ws = join(tmp, "ws-backfill");
    mkdirSync(join(ws, "tau"), { recursive: true });
    // Agent-authored plan: one mutate slot and one report slot.
    writeTauTodos(ws, {
      slots: [
        { id: "mutate_1_cancel_pending_order", kind: "mutate", value: null },
        { id: "report_2_fact", kind: "report", value: null },
      ],
    });
    // Worker output contains the gold output string of retail-019 among other numbers.
    writeFileSync(join(ws, "tau", "outputs.log"), "totals: 12.00 54.04 99.99\n");
    writeFileSync(
      join(ws, "tau", "actions.jsonl"),
      JSON.stringify({ name: "cancel_pending_order", kwargs: { order_id: "#W1" }, result: "ok" }) + "\n",
    );
    assert.equal(backfillMutateSlotsFromActions(ws), true);
    const t = readTauTodos(ws);
    assert.equal(t.slots[0].value, "cancel_pending_order #W1");
    assert.equal(t.slots[1].value ?? null, null, "report slot stays the agent's job");
  });

  it("the runner no longer reads grading data for host decisions", () => {
    const src = readFileSync(join(here, "case-study-coding.mjs"), "utf8");
    assert.doesNotMatch(src, /gold_actions|grade\?\.outputs|tauTodoSlots/);
    for (const f of readdirSync(join(here, "lib"))) {
      if (f === "workspace.mjs") continue;
      const lib = readFileSync(join(here, "lib", f), "utf8");
      assert.doesNotMatch(lib, /gold_actions|\.grade\b/, f);
    }
  });
});
