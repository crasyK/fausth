/**
 * τ-retail domain world (case-studies/tau-bench) — kept out of the generic local adapter.
 *
 * Enabled only when a deployment binds one of {@link TAU_NATIVES}. It contributes to the
 * generic local world:
 *  - host control files under tau/ that the agent can never write (API request/response,
 *    action log, todo slots) — host-derived state is read back only from these;
 *  - one declarative write effect: writing the final answer file finalizes the episode;
 *  - the `tau` world command is reserved for tau.invoke (not runnable via the shell tool).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ToolHandler } from "../../runtime.js";
import type { Deployment, ToolResultEnvelope } from "../../types.js";
import { runWorldCommand, type LocalWorld, type LocalWorldExtension } from "../local.js";

/** Deployment natives provided by this domain world → harness tool ids they implement. */
export const TAU_NATIVES: Record<string, string> = {
  "local.tau_invoke": "tau.invoke",
  "local.todo_complete": "todo.complete",
};

const TAU_DIR = "tau";
const TODOS = `${TAU_DIR}/todos.json`;
const ACTIONS = `${TAU_DIR}/actions.jsonl`;
const REQUEST = `${TAU_DIR}/request.json`;
const RESPONSE = `${TAU_DIR}/response.txt`;
const OUTPUTS = `${TAU_DIR}/outputs.log`;
const FINAL = `${TAU_DIR}/final.txt`;

export function deploymentUsesTauWorld(deployment: Deployment): boolean {
  return Object.values(deployment.bindings ?? {}).some(
    (b) => typeof b?.native === "string" && Object.prototype.hasOwnProperty.call(TAU_NATIVES, b.native),
  );
}

/** Hooks the τ world registers in the generic local world. */
export const TAU_WORLD_EXTENSION: LocalWorldExtension = {
  controlPaths: [TODOS, ACTIONS, REQUEST, RESPONSE, OUTPUTS],
  writeEffects: [{ path: FINAL, set: { finalized: 1, open_todos: 0 } }],
  claimedCommands: ["tau"],
};

const MUTATING_TAU_TOOLS = new Set([
  "cancel_pending_order",
  "return_delivered_order_items",
  "exchange_delivered_order_items",
  "modify_pending_order_items",
  "modify_pending_order_address",
  "modify_pending_order_payment",
  "modify_user_address",
  "transfer_to_human_agents",
]);

function mutateToolsFromSlotId(slotId: string): string[] | null {
  const m = /^mutate_\d+_(.+)$/.exec(slotId);
  if (!m?.[1]) return null;
  return m[1].split("_or_").filter(Boolean);
}

function slotFilled(s: Record<string, unknown>): boolean {
  return s?.value != null && String(s.value) !== "";
}

/** Natives for the τ world bound to a generic local world. */
export function createTauWorldTools(world: LocalWorld): Record<string, ToolHandler> {
  const abs = (rel: string) => join(world.root, rel);

  function readTodoSlots(): Array<Record<string, unknown>> {
    if (!existsSync(abs(TODOS))) return [];
    try {
      const doc = JSON.parse(readFileSync(abs(TODOS), "utf8")) as { slots?: Array<Record<string, unknown>> };
      return Array.isArray(doc.slots) ? doc.slots : [];
    } catch {
      return [];
    }
  }

  function actionLines(): Array<{ name: string; result: string }> {
    if (!existsSync(abs(ACTIONS))) return [];
    const out: Array<{ name: string; result: string }> = [];
    for (const line of readFileSync(abs(ACTIONS), "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const a = JSON.parse(line) as { name?: string; tool?: string; result?: string };
        out.push({ name: String(a?.name ?? a?.tool ?? ""), result: String(a?.result ?? "") });
      } catch {
        /* skip bad line */
      }
    }
    return out;
  }

  function openMutateToolSet(slots: Array<Record<string, unknown>>): { open: Set<string>; hasMutateSlots: boolean } {
    const open = new Set<string>();
    let hasMutateSlots = false;
    for (const s of slots) {
      const tools = mutateToolsFromSlotId(String(s?.id ?? ""));
      if (!tools?.length) continue;
      hasMutateSlots = true;
      if (slotFilled(s)) continue;
      for (const t of tools) open.add(t);
    }
    return { open, hasMutateSlots };
  }

  /** Stage tau/request.json + run world.commands.tau; return the API result as observation. */
  const tauInvoke: ToolHandler = async (args, ctx) => {
    const tool = String(args.tool ?? args.name ?? "");
    const kwargs =
      args.kwargs && typeof args.kwargs === "object" && !Array.isArray(args.kwargs)
        ? (args.kwargs as Record<string, unknown>)
        : args.args && typeof args.args === "object" && !Array.isArray(args.args)
          ? (args.args as Record<string, unknown>)
          : {};
    if (!tool) {
      return { output: { ok: 0, tool: "", kwargs: {}, result: "", error: "missing tool name" } };
    }
    // Slot-backed mutation guard: mutating tools must match an open mutate_* slot.
    if (MUTATING_TAU_TOOLS.has(tool)) {
      const slots = readTodoSlots();
      if (slots.length > 0) {
        const { open, hasMutateSlots } = openMutateToolSet(slots);
        const allowed = hasMutateSlots && open.size > 0 ? [...open].sort() : [];
        const blocked = !hasMutateSlots || open.size === 0 || !open.has(tool);
        if (blocked) {
          const offPlan = Number(ctx.state.off_plan_mutations ?? 0);
          const openIds = slots
            .filter((s) => mutateToolsFromSlotId(String(s?.id ?? "")) && !slotFilled(s))
            .map((s) => String(s.id));
          const hint = !hasMutateSlots
            ? "No mutate_* slots — this is a resolve/report-only plan. Do not mutate; fill resolve/report via todo.complete."
            : open.size === 0
              ? "All mutate_* slots are already filled — do not mutate further."
              : `No open slot requires ${tool}. Open slots: [${openIds.join(", ") || "none"}].`;
          return {
            output: {
              ok: 0,
              tool,
              kwargs,
              result: "",
              error: "off_plan_mutation",
              off_plan: 1,
              warning: offPlan < 1 ? `Off-plan mutation blocked (warning). ${hint}` : `Off-plan mutation denied. ${hint}`,
              hint,
              open_mutate_tools: allowed,
            },
            state_transition: { set: { off_plan_mutations: offPlan + 1 } },
          };
        }
      }
    }
    const argv = world.commands.get("tau");
    if (!argv || argv.length === 0) {
      return {
        output: {
          ok: 0,
          tool,
          kwargs,
          result: "",
          error: "tau command not configured in deployment.world.commands",
        },
      };
    }
    mkdirSync(abs(TAU_DIR), { recursive: true });
    writeFileSync(abs(REQUEST), JSON.stringify({ tool, kwargs }), "utf8");
    const r = await runWorldCommand(world, argv, { hostControlWrites: true });
    const result = r.stdout.replace(/\n$/, "");
    if (r.exitCode === 0) {
      // Belt-and-suspenders for graders: accumulate results beyond response.txt overwrite.
      writeFileSync(abs(OUTPUTS), `${result}\n`, { flag: "a" });
      return {
        output: {
          ok: 1,
          tool,
          kwargs,
          result,
          exit_code: 0,
          stderr: r.stderr,
          truncated: r.truncated ? 1 : 0,
        },
        state_transition: { set: { test_evidence_current: 1, researched: 1 } },
      };
    }
    if (result) writeFileSync(abs(OUTPUTS), `${result}\n`, { flag: "a" });
    return {
      output: {
        ok: 0,
        tool,
        kwargs,
        result,
        exit_code: r.exitCode,
        stderr: r.stderr,
        truncated: r.truncated ? 1 : 0,
        error: r.timedOut ? "timeout" : "tau_failed",
      },
    };
  };

  /** Fill one todo slot by id; host-writes tau/todos.json and drives open_todos. */
  const todoComplete: ToolHandler = (args) => {
    const slotId = String(args.id ?? args.slot_id ?? args.todo ?? "");
    const valueRaw = args.value;
    const value =
      valueRaw == null || valueRaw === "" ? "done" : typeof valueRaw === "string" ? valueRaw : JSON.stringify(valueRaw);
    if (!slotId) {
      return { output: { ok: 0, error: "missing_id", id: "", value: "" } };
    }
    let doc: { version?: number; slots?: Array<Record<string, unknown>> } = { version: 1, slots: [] };
    if (existsSync(abs(TODOS))) {
      try {
        doc = JSON.parse(readFileSync(abs(TODOS), "utf8"));
      } catch {
        return { output: { ok: 0, error: "todos_unreadable", id: slotId, value } };
      }
    }
    const slots = Array.isArray(doc.slots) ? doc.slots : [];
    const idx = slots.findIndex((s) => String(s?.id ?? "") === slotId);
    if (idx < 0) {
      return {
        output: {
          ok: 0,
          error: "unknown_slot",
          id: slotId,
          value,
          known_ids: slots.map((s) => String(s?.id ?? "")),
        },
      };
    }
    const actions = actionLines();
    const slotKind = String(slots[idx]?.kind ?? "");
    // resolve_* requires a clean (unmutated) DB / action log.
    if (slotKind === "resolve" || slotId.startsWith("resolve_")) {
      const mutCount = actions.filter((a) => MUTATING_TAU_TOOLS.has(a.name) && !a.result.startsWith("Error:")).length;
      if (mutCount > 0) {
        return {
          output: {
            ok: 0,
            error: "resolve_requires_no_mutations",
            id: slotId,
            value,
            mutating_actions: mutCount,
            hint: "resolve slots are for no-mutation outcomes; undo is impossible — do not mutate on resolve-only plans",
          },
        };
      }
    }
    // mutate_N_<tool> or mutate_N_<toolA_or_toolB> require matching successful actions.
    const requiredTools = mutateToolsFromSlotId(slotId);
    if (requiredTools?.length) {
      const hitTools = actions.filter((a) => a.name && !a.result.startsWith("Error:")).map((a) => a.name);
      const toolSetKey = [...requiredTools].sort().join("|");
      let filledSameTool = 0;
      for (let i = 0; i < slots.length; i++) {
        const tools = mutateToolsFromSlotId(String(slots[i]?.id ?? ""));
        if (!tools?.length) continue;
        if ([...tools].sort().join("|") !== toolSetKey) continue;
        const already = i !== idx && slots[i]?.value != null && String(slots[i]!.value) !== "";
        if (already || i === idx) filledSameTool += 1;
      }
      const have = hitTools.filter((t) => requiredTools.includes(t)).length;
      if (have < filledSameTool) {
        return {
          output: {
            ok: 0,
            error: "mutate_tool_mismatch",
            id: slotId,
            value,
            required_tools: requiredTools,
            actions_of_tool: have,
            slots_of_tool: filledSameTool,
            hint: `Call tau.invoke tool=${requiredTools.join("|")} successfully before todo.complete on this slot`,
          },
        };
      }
    }
    slots[idx] = { ...slots[idx], value, filled: true };
    const filled = slots.filter((s) => slotFilled(s)).length;
    const allFilled = slots.length > 0 && filled === slots.length;
    mkdirSync(dirname(abs(TODOS)), { recursive: true });
    writeFileSync(abs(TODOS), JSON.stringify({ version: doc.version ?? 1, slots }, null, 2) + "\n", "utf8");
    const envelope: ToolResultEnvelope = {
      output: {
        ok: 1,
        id: slotId,
        value,
        slots_filled: filled,
        slots_total: slots.length,
        all_filled: allFilled ? 1 : 0,
      },
      state_transition: { set: { slots_filled: filled, ...(allFilled ? { open_todos: 0 } : {}) } },
    };
    return envelope;
  };

  return {
    "local.tau_invoke": tauInvoke,
    "local.todo_complete": todoComplete,
  };
}
