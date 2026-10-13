"""Model-adaptive scaffolding overlays (M18) — mirrors engines/ts/src/overlays.ts.

Overlays are declarative, resolved by deployment model id, and may only narrow
capability surfaces (tools, limits) — never widen. ``permissions.tools: []``
means *no tool permitted* (D5), so an overlay can never re-grant tools from it.
"""
from __future__ import annotations

from typing import Any

from .canonical import UNDEFINED, jget, js_string, js_truthy, nn
from .runtime import js_gt


class OverlayError(ValueError):
    pass


def _pick_model_id(deployment: Any) -> Any:
    model = jget(deployment, "model")
    return nn(jget(model, "model"), jget(jget(model, "models"), "0"))


def _model_matches(when: Any, model_id: Any) -> bool:
    lst = when if isinstance(when, list) else [when]
    return any(x == model_id and type(x) is type(model_id) for x in lst)


def _narrow_tools(base: dict[str, Any], overlay_tools: list[Any]) -> dict[str, Any]:
    base_ids = [jget(t, "id") for t in base.get("tools") or []]
    perm_tools = jget(base.get("permissions", UNDEFINED), "tools")
    allowed = perm_tools if js_truthy(perm_tools) else base_ids
    for tid in overlay_tools:
        if tid not in allowed:
            raise OverlayError(f"overlay widens tools: '{js_string(tid)}' not in base permissions")
    keep = list(overlay_tools)
    tools = [t for t in base.get("tools") or [] if jget(t, "id") in keep]
    perms = dict(base.get("permissions") or {})
    perms["tools"] = overlay_tools
    return {**base, "tools": tools, "permissions": perms}


def _narrow_limits(base: Any, overlay: Any) -> Any:
    if not js_truthy(overlay):
        return base
    out = dict(base) if isinstance(base, dict) else {}
    for key in ("max_steps", "max_tool_calls", "timeout_ms"):
        nxt = jget(overlay, key)
        if nxt is UNDEFINED:
            continue
        cur = out.get(key, UNDEFINED)
        if cur is not UNDEFINED and js_gt(nxt, cur):
            raise OverlayError(f"overlay widens limits.{key}: {js_string(nxt)} > {js_string(cur)}")
        out[key] = nxt
    return out


def resolve_overlay(agent: dict[str, Any], deployment: Any) -> dict[str, Any]:
    """Apply the first matching overlay from ``agent.overlays`` (TS ``resolveOverlay``)."""
    overlays = nn(agent.get("overlays", UNDEFINED), [])
    if not overlays:
        return {"overlay": None, "agent": agent, "reason": "no overlays"}
    model_id = _pick_model_id(deployment)
    if not js_truthy(model_id):
        return {"overlay": None, "agent": agent, "reason": "no deployment model id"}
    hit = next((o for o in overlays if _model_matches(jget(o, "when_model"), model_id)), None)
    if hit is None:
        return {"overlay": None, "agent": agent, "reason": f"no overlay for model {js_string(model_id)}"}
    nxt = {k: v for k, v in agent.items() if k != "overlays"}
    if js_truthy(jget(hit, "tools")):
        nxt = _narrow_tools(nxt, hit["tools"])
    if js_truthy(jget(hit, "limits")):
        nxt = {**nxt, "limits": _narrow_limits(nxt.get("limits", UNDEFINED), hit["limits"])}
    return {"overlay": hit, "agent": nxt, "reason": f"matched {js_string(model_id)}"}
