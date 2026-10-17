"""Rendering (spec §9): the provider-neutral request, a function of the harness and the log."""
from __future__ import annotations

from typing import Any

from .log import Scope, in_scope
from .values import canonical


def result_text(ok: bool, value: Any) -> str:
    """What the model sees of a tool result (§9.3)."""
    if not ok:
        return canonical({"error": value})
    return value if isinstance(value, str) else canonical(value)


def render(harness: dict[str, Any], entries: list[dict[str, Any]], scope: Scope) -> dict[str, Any]:
    system = ""
    messages: list[dict[str, Any]] = []
    for e in entries:
        if not in_scope(e, scope):
            continue
        if e["type"] == "system":
            system = e["text"]
        elif e["type"] == "user":
            messages.append({"role": "user", "text": e["text"]})
        elif e["type"] == "assistant":
            messages.append({"role": "assistant", "text": e["text"], "tool_calls": e["tool_calls"]})
        elif e["type"] == "tool_result":
            text = result_text(True, e["result"]) if e["ok"] else result_text(False, e["error"])
            messages.append({"role": "tool", "call_id": e["call_id"], "tool": e["tool"], "text": text})
    declared = harness.get("tools", {})
    tools = [
        {"name": name, "description": declared[name].get("description", ""), "input": declared[name].get("input", {})}
        for name in sorted(declared)
    ]
    return {"system": system, "tools": tools, "messages": messages}
