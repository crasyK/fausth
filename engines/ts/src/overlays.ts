/**
 * Model-adaptive scaffolding overlays (M18).
 *
 * Overlays are declarative, resolved by deployment model id.
 * They may only narrow capability surfaces (tools, limits) — never widen.
 */
import type { AgentIR, Deployment } from "./types.js";

export type HarnessOverlay = {
  /** Match deployment model id / catalog id. */
  when_model: string | string[];
  /** Optional tool allowlist (must be ⊆ base permissions.tools / tools). */
  tools?: string[];
  /** Optional limits that may only tighten (lower max_*). */
  limits?: {
    max_steps?: number;
    max_tool_calls?: number;
    timeout_ms?: number;
  };
  /** Optional system prompt fragment for host teaching (not Track A). */
  prompt_hint?: string;
};

export type OverlayResolution = {
  overlay: HarnessOverlay | null;
  agent: AgentIR;
  reason: string;
};

function modelMatches(when: string | string[], modelId: string): boolean {
  const list = Array.isArray(when) ? when : [when];
  return list.includes(modelId);
}

function pickModelId(deployment: Deployment): string | undefined {
  return deployment.model?.model ?? deployment.model?.models?.[0];
}

/** Narrow tools: overlay tools must be a subset of base. */
function narrowTools(base: AgentIR, overlayTools: string[]): AgentIR {
  const baseIds = new Set(base.tools.map((t) => t.id));
  const allowed = base.permissions?.tools
    ? new Set(base.permissions.tools)
    : baseIds;
  for (const id of overlayTools) {
    if (!allowed.has(id)) {
      throw new Error(`overlay widens tools: '${id}' not in base permissions`);
    }
  }
  const keep = new Set(overlayTools);
  const tools = base.tools.filter((t) => keep.has(t.id));
  const permissions = {
    ...base.permissions,
    tools: overlayTools,
  };
  return { ...base, tools, permissions };
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
    const cur = out[key];
    if (cur !== undefined && next > cur) {
      throw new Error(`overlay widens limits.${key}: ${next} > ${cur}`);
    }
    out[key] = next;
  }
  return out;
}

/**
 * Apply the first matching overlay from `agent.overlays` (if present).
 * Agents without overlays are returned unchanged.
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
