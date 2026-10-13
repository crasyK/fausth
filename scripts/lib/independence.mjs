/**
 * Sample-independence checks for repeated attempts.
 *
 * Repetitions are only independent samples if the model actually re-sampled.
 * A request-body cache at the gateway (KIT caches kit.glm-5.3-flash) or fully
 * deterministic decoding makes reps 2..R exact copies of rep 1. We detect this
 * two ways:
 *   - completion ids recorded per model call (when the transport reports them)
 *   - a trajectory fingerprint (hash of the proposal sequence) per attempt
 * Duplicates across reps of the same (task, condition, model, deployment) unit
 * are reported in `summary.independence`.
 */
import { createHash } from "node:crypto";

/** @param {unknown} v */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    /** @type {Record<string, unknown>} */
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canonical(/** @type {any} */ (v)[k]);
    return o;
  }
  return v;
}

/** @param {string} text */
function parseLines(text) {
  /** @type {Array<Record<string, any>>} */
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Completion ids reported by the engine for each model call (if any).
 * Accepted shapes: report.completion_ids[], report.completions[].id, or event
 * fields completion_id / response_id / transport.completion_id / model_call.id.
 * @param {{ report?: Record<string, any> | null, eventsText?: string }} input
 * @returns {string[]}
 */
export function extractCompletionIds(input) {
  /** @type {string[]} */
  const ids = [];
  const push = (v) => {
    if (typeof v === "string" && v) ids.push(v);
  };
  const r = input.report ?? {};
  if (Array.isArray(r.completion_ids)) r.completion_ids.forEach(push);
  if (Array.isArray(r.completions)) for (const c of r.completions) push(c?.id ?? c?.completion_id);
  for (const e of parseLines(input.eventsText ?? "")) {
    push(e.completion_id);
    push(e.response_id);
    push(e.transport?.completion_id);
    push(e.model_call?.id ?? e.model_call?.completion_id);
  }
  return [...new Set(ids)];
}

/**
 * sha256 over the ordered proposals (tool + canonical args) of an attempt.
 * @param {string} eventsText
 * @returns {string | null}
 */
export function trajectoryFingerprint(eventsText) {
  const proposals = parseLines(eventsText)
    .filter((e) => e.stage === "propose")
    .map((e) => JSON.stringify([e.tool ?? null, canonical(e.args ?? null)]));
  if (!proposals.length) return null;
  return createHash("sha256").update(proposals.join("\n")).digest("hex");
}

/** @param {Record<string, any>} a */
function unitGroup(a) {
  return [
    a.task_id,
    a.condition,
    a.model_id,
    a.deployment_id,
    a.phase ?? "",
    a.train_pass ?? "",
    a.try_index ?? "",
  ].join("|");
}

/**
 * @param {Array<Record<string, any>>} attempts ledger rows (with completion_ids / trajectory_sha256)
 * @param {{ mode?: string, cachedModels?: string[] }} [opts]
 */
export function independenceReport(attempts, opts = {}) {
  const rows = (attempts ?? []).filter((a) => a && a.status === "scored");
  /** @type {Map<string, string[]>} */
  const byCompletion = new Map();
  let withIds = 0;
  for (const a of rows) {
    const ids = Array.isArray(a.completion_ids) ? a.completion_ids : [];
    if (ids.length) withIds += 1;
    for (const id of ids) {
      if (!byCompletion.has(id)) byCompletion.set(id, []);
      byCompletion.get(id).push(String(a.attempt_id));
    }
  }
  const duplicateCompletionIds = [...byCompletion.entries()]
    .filter(([, list]) => new Set(list).size > 1)
    .map(([id, list]) => ({ completion_id: id, attempts: [...new Set(list)].sort() }));

  /** @type {Map<string, Map<string, string[]>>} */
  const groups = new Map();
  for (const a of rows) {
    if (!a.trajectory_sha256) continue;
    const g = unitGroup(a);
    if (!groups.has(g)) groups.set(g, new Map());
    const m = groups.get(g);
    if (!m.has(a.trajectory_sha256)) m.set(a.trajectory_sha256, []);
    m.get(a.trajectory_sha256).push(String(a.attempt_id));
  }
  /** @type {Array<{ unit: string, trajectory_sha256: string, attempts: string[] }>} */
  const duplicateTrajectories = [];
  for (const [g, m] of groups) {
    for (const [sha, list] of m) {
      if (list.length > 1) {
        duplicateTrajectories.push({ unit: g, trajectory_sha256: sha, attempts: list.sort() });
      }
    }
  }
  const ok = duplicateCompletionIds.length === 0 && duplicateTrajectories.length === 0;
  return {
    ok,
    cached_models: opts.cachedModels ?? [],
    completion_ids_recorded: withIds > 0,
    n_attempts_with_completion_ids: withIds,
    duplicate_completion_ids: duplicateCompletionIds,
    duplicate_trajectories: duplicateTrajectories,
    note: ok
      ? "no duplicate completions or trajectories across repetitions"
      : opts.mode === "recorded"
        ? "recorded mode replays identical traces; repetitions are not samples"
        : "repetitions with identical completions/trajectories are not independent samples (gateway cache or deterministic decoding)",
  };
}
