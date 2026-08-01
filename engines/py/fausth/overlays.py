"""Model-adaptive scaffolding overlays (M18) — mirrors engines/ts/src/overlays.ts."""
from __future__ import annotations

from typing import Any


def _pick_model_id(deployment: dict[str, Any]) -> str | None:
    model = deployment.get("model") or {}
    if model.get("model"):
        return str(model["model"])
    models = model.get("models") or []
    return str(models[0]) if models else None


def _model_matches(when: str | list[str], model_id: str) -> bool:
    lst = when if isinstance(when, list) else [when]
    return model_id in lst


def resolve_overlay(agent: dict[str, Any], deployment: dict[str, Any]) -> dict[str, Any]:
    overlays = agent.get("overlays") or []
    if not overlays:
        return {"overlay": None, "agent": agent, "reason": "no overlays"}
    model_id = _pick_model_id(deployment)
    if not model_id:
        return {"overlay": None, "agent": agent, "reason": "no deployment model id"}
    hit = next((o for o in overlays if _model_matches(o.get("when_model"), model_id)), None)
    if not hit:
        return {"overlay": None, "agent": agent, "reason": f"no overlay for model {model_id}"}
    next_agent = {k: v for k, v in agent.items() if k != "overlays"}
    if hit.get("tools") is not None:
        allowed = set((agent.get("permissions") or {}).get("tools") or [t["id"] for t in agent.get("tools") or []])
        for tid in hit["tools"]:
            if tid not in allowed:
                raise ValueError(f"overlay widens tools: '{tid}' not in base permissions")
        keep = set(hit["tools"])
        next_agent["tools"] = [t for t in agent.get("tools") or [] if t["id"] in keep]
        perms = dict(agent.get("permissions") or {})
        perms["tools"] = list(hit["tools"])
        next_agent["permissions"] = perms
    if hit.get("limits"):
        base_limits = dict(agent.get("limits") or {})
        for key in ("max_steps", "max_tool_calls", "timeout_ms"):
            if key not in hit["limits"]:
                continue
            nxt = hit["limits"][key]
            cur = base_limits.get(key)
            if cur is not None and nxt > cur:
                raise ValueError(f"overlay widens limits.{key}: {nxt} > {cur}")
            base_limits[key] = nxt
        next_agent["limits"] = base_limits
    return {"overlay": hit, "agent": next_agent, "reason": f"matched {model_id}"}
