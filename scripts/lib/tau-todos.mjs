/**
 * τ todo-delegate host plumbing — gold-free (SCR-14).
 *
 * Grading data (the task.yml `grade` section: gold actions, required outputs) is
 * for grading only. Nothing here reads task.yml: the host seeds the SAME empty todo plan for every task, never
 * derives slots, tool names, slot counts or a "no action" signal from gold, and
 * never selects report facts using gold outputs. Slots are authored by the
 * agent; the host may only mirror the agent's own successful actions into
 * agent-authored mutate slots.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const TODOS_REL = "tau/todos.json";

/** Mutating τ retail tools (public API catalog, not task gold). */
export const MUTATING_TAU_TOOLS = new Set([
  "cancel_pending_order",
  "return_delivered_order_items",
  "exchange_delivered_order_items",
  "modify_pending_order_items",
  "modify_pending_order_address",
  "modify_pending_order_payment",
  "modify_user_address",
  "transfer_to_human_agents",
]);

/**
 * Initial plan the host provisions — identical for every task.
 * @returns {{ version: number, slots: Array<Record<string, unknown>>, authored_by: string }}
 */
export function initialTodoPlan() {
  return { version: 1, slots: [], authored_by: "host:empty" };
}

/**
 * @param {string} worktree
 * @param {{ version?: number, slots: Array<Record<string, any>>, authored_by?: string }} plan
 */
export function writeTauTodos(worktree, plan) {
  const p = join(worktree, TODOS_REL);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(
    p,
    JSON.stringify(
      {
        version: plan.version ?? 1,
        ...(plan.authored_by ? { authored_by: plan.authored_by } : {}),
        slots: (plan.slots ?? []).map((s) => ({
          ...s,
          filled: s.value != null && String(s.value) !== "",
        })),
      },
      null,
      2,
    ) + "\n",
  );
}

/**
 * Read slots back after a phase.
 * @param {string} worktree
 */
export function readTauTodos(worktree) {
  const p = join(worktree, TODOS_REL);
  if (!existsSync(p)) return { slots: [], all_filled: false, has_slots: false };
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    const slots = Array.isArray(j?.slots) ? j.slots : [];
    const allFilled =
      slots.length > 0 && slots.every((s) => s?.value != null && String(s.value) !== "");
    return { slots, all_filled: allFilled, has_slots: slots.length > 0 };
  } catch {
    return { slots: [], all_filled: false, has_slots: false };
  }
}

/** @param {string} worktree */
function readActions(worktree) {
  const actionsPath = join(worktree, "tau", "actions.jsonl");
  if (!existsSync(actionsPath)) return [];
  return readFileSync(actionsPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Mirror the worker's own successful mutations into unfilled, agent-authored
 * `mutate_<n>_<tool>` slots. Report / resolve slots are never filled by the host.
 * @param {string} worktree
 * @returns {boolean} whether any slot changed
 */
export function backfillMutateSlotsFromActions(worktree) {
  const cur = readTauTodos(worktree);
  if (cur.all_filled || !cur.slots.length) return false;
  const hits = [];
  for (const a of readActions(worktree)) {
    const name = String(a?.name ?? a?.tool ?? "");
    if (!MUTATING_TAU_TOOLS.has(name)) continue;
    if (String(a?.result ?? "").startsWith("Error:")) continue;
    const oid = a?.kwargs?.order_id ?? a?.kwargs?.user_id ?? "";
    hits.push({ name, label: `${name}${oid ? ` ${oid}` : ""}`, used: false });
  }
  const toolsFromSlotId = (id) => {
    const m = /^mutate_\d+_(.+)$/.exec(String(id ?? ""));
    return m?.[1] ? m[1].split("_or_").filter(Boolean) : [];
  };
  let changed = false;
  const slots = cur.slots.map((s) => {
    if (s?.value != null && String(s.value) !== "") return s;
    if (s?.kind !== "mutate") return s;
    const allowed = toolsFromSlotId(s.id);
    const hit = hits.find((h) => !h.used && allowed.includes(h.name));
    if (!hit) return s;
    hit.used = true;
    changed = true;
    return { ...s, value: hit.label, filled: true };
  });
  if (changed) writeTauTodos(worktree, { version: 1, slots });
  return changed;
}

/**
 * Finalize-phase prompt: the task prompt plus the slot values the WORKER wrote.
 * Contains nothing from grading data.
 * @param {string} basePromptPath
 * @param {string} worktree
 * @param {string} outPath
 */
export function writeTauFinalizePrompt(basePromptPath, worktree, outPath) {
  const base = readFileSync(basePromptPath, "utf8");
  const t = readTauTodos(worktree);
  const lines = t.slots.map(
    (s) => `- ${s.id} (${s.kind}): ${s.value != null ? JSON.stringify(s.value) : "(unfilled)"}`,
  );
  writeFileSync(
    outPath,
    `${base}

---
Host finalize brief (read-only context — do NOT re-run the retail task):
The worker phase has ended. Your ONLY job:
1. Write tau/final.txt with the outcome for the customer, including every fact the worker
   recorded below verbatim (each amount, tracking number or fact as its own substring).
2. Call task.complete.

Worker-recorded slots:
${lines.join("\n") || "(none recorded)"}

Do NOT write tau/request.json. Do NOT invent API calls. Path MUST be tau/final.txt.
`,
  );
}
