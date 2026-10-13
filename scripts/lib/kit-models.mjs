/**
 * KIT model catalog for host scripts (D15).
 *
 * Live model runs use `kit.glm-5.3-flash` (default) or `kit.deepseek-v4-flash`.
 * Older ids are retired at the gateway; runs that name them fail fast instead of
 * producing a matrix of 404 "infra" exclusions.
 *
 * Gateway caching: the KIT gateway caches `kit.glm-5.3-flash` completions by
 * request body — identical requests return identical completions even at
 * temperature 0.7 — so repeated identical runs are NOT independent samples.
 */
export const KIT_BASE_URL = "https://ki-toolbox.scc.kit.edu/api/v1";
export const KIT_API_KEY_ENV = "KIT_AI_API_KEY";
export const DEFAULT_KIT_MODEL = "kit.glm-5.3-flash";

/** Models a live matrix may use (`--kit-models all`); glm stays the default. */
export const ALL_KIT_MODELS = [DEFAULT_KIT_MODEL, "kit.deepseek-v4-flash"];

/** Models whose completions the gateway caches by request body. */
export const CACHED_KIT_MODELS = new Set([DEFAULT_KIT_MODEL]);

/** Retired ids (exact) and families (prefix) — rejected for live runs. */
export const RETIRED_KIT_MODELS = new Set(["kit.minimax-m2.7-229b"]);
const RETIRED_PREFIXES = ["kit.gemma"];

/** @param {string} model */
export function isRetiredKitModel(model) {
  const m = String(model ?? "");
  return RETIRED_KIT_MODELS.has(m) || RETIRED_PREFIXES.some((p) => m.startsWith(p));
}

/** @param {string} model */
export function isGatewayCachedModel(model) {
  return CACHED_KIT_MODELS.has(String(model ?? ""));
}

/**
 * Throw when any requested live model is retired.
 * @param {string[]} models
 * @param {string} [where]
 */
export function assertLiveKitModels(models, where = "live run") {
  const retired = (models ?? []).filter(isRetiredKitModel);
  if (retired.length) {
    throw new Error(
      `${where}: retired KIT model id(s) ${retired.join(", ")} — use ${ALL_KIT_MODELS.join(" or ")} (D15)`,
    );
  }
}

/**
 * Warnings for repetitions that would hit a request-body cache (non-independent reps).
 * @param {{ models: string[], reps: number }} opts
 * @returns {Array<{ kind: string, models: string[], reps: number, message: string }>}
 */
export function gatewayCacheWarnings(opts) {
  const cached = (opts.models ?? []).filter(isGatewayCachedModel);
  if (!cached.length || !(Number(opts.reps) > 1)) return [];
  return [
    {
      kind: "gateway_cache_non_independent_reps",
      models: cached,
      reps: Number(opts.reps),
      message:
        `${cached.join(", ")}: the KIT gateway caches completions by request body; ` +
        `reps 2..${opts.reps} send byte-identical first requests and are NOT independent samples. ` +
        "Duplicate trajectories / completion ids are flagged in summary.independence.",
    },
  ];
}

/** Short label for session / run ids. @param {string} model */
export function shortKitModel(model) {
  return String(model)
    .replace(/^kit\./, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}
