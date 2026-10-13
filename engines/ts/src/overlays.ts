/**
 * Model-adaptive scaffolding overlays (spec-v0.3 §4.4).
 *
 * Overlays are declarative, resolved by deployment model id, and may only narrow capability
 * surfaces (permitted tools, limits) relative to the EFFECTIVE base — never widen.
 */
import type { AgentIR, Deployment } from "./types.js";

export type HarnessOverlay = {
  /** Match deployment model id / catalog id. */
  when_model: string | string[];
  /** Optional tool allowlist (must be ⊆ the base permitted set). */
  tools?: string[];
  /** Optional limits that may only tighten (≤ the effective base value). */
  limits?: {
    max_steps?: number;
    max_tool_calls?: number;
    timeout_ms?: number;
  };
  /** Harness-authored host teaching text for this model. */
  prompt_hint?: string;
};

export type OverlayResolution = {
  overlay: HarnessOverlay | null;
  agent: AgentIR;
  reason: string;
};

/** Effective defaults for unset limits (spec-v0.3 §2.1); unset timeout = unbounded. */
const EFFECTIVE_DEFAULT: Record<"max_steps" | "max_tool_calls" | "timeout_ms", number> = {
  max_steps: 1000,
  max_tool_calls: 1000,
  timeout_ms: Number.POSITIVE_INFINITY,
};

function modelMatches(when: string | string[], modelId: string): boolean {
  const list = Array.isArray(when) ? when : [when];
  return list.includes(modelId);
}

function pickModelId(deployment: Deployment): string | undefined {
  return deployment.model?.model ?? deployment.model?.models?.[0];
}

/** Base permitted set (D5): permissions.tools when present, else every declared tool. */
function basePermitted(base: AgentIR): Set<string> {
  const declared = new Set(base.tools.map((t) => t.id));
  const p = base.permissions?.tools;
  return p === undefined ? declared : new Set(p.filter((id) => declared.has(id)));
}

/** Narrow the permitted set; declarations are kept so references stay valid. */
function narrowTools(base: AgentIR, overlayTools: string[]): AgentIR {
  const allowed = basePermitted(base);
  for (const id of overlayTools) {
    if (!allowed.has(id)) {
      throw new Error(`overlay widens tools: '${id}' not in base permitted set`);
    }
  }
  return { ...base, permissions: { ...base.permissions, tools: [...overlayTools] } };
}

function narrowLimits(
  base: AgentIR["limits"] | undefined,
  overlay: HarnessOverlay["limits"],
): AgentIR["limits"] | undefined {
  if (!overlay) return base;
  const out: NonNullable<AgentIR["limits"]> = { ...(base ?? {}) };
  for (const key of ["max_steps", "max_tool_calls", "timeout_ms"] as const) {
    const next = overlay[key];
    if (next === undefined) continue;
    const min = key === "timeout_ms" ? 1 : 0;
    if (typeof next !== "number" || !Number.isInteger(next) || next < min) {
      throw new Error(`overlay limits.${key} must be an integer ≥ ${min}`);
    }
    const effective = out[key] ?? EFFECTIVE_DEFAULT[key];
    if (next > effective) {
      throw new Error(`overlay widens limits.${key}: ${next} > ${effective}`);
    }
    out[key] = next;
  }
  return out;
}

/**
 * Apply the first matching overlay from `agent.overlays` (if present).
 * The result never carries `overlays`. Agents without overlays are returned unchanged.
 */
export function resolveOverlay(
  agent: AgentIR & { overlays?: HarnessOverlay[] },
  deployment: Deployment,
): OverlayResolution {
  const overlays = agent.overlays ?? [];
  if (!overlays.length) {
    return { overlay: null, agent, reason: "no overlays" };
  }
  const modelId = pickModelId(deployment);
  if (!modelId) {
    return { overlay: null, agent, reason: "no deployment model id" };
  }
  const hit = overlays.find((o) => modelMatches(o.when_model, modelId));
  if (!hit) {
    return { overlay: null, agent, reason: `no overlay for model ${modelId}` };
  }
  let next: AgentIR = { ...agent };
  delete (next as { overlays?: HarnessOverlay[] }).overlays;
  if (hit.tools) next = narrowTools(next, hit.tools);
  if (hit.limits) next = { ...next, limits: narrowLimits(next.limits, hit.limits) };
  return { overlay: hit, agent: next, reason: `matched ${modelId}` };
}
