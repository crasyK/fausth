"""Rendering (spec §9): the provider-neutral request, a function of the harness and the log."""
from __future__ import annotations

from typing import Any

from .harness import shown_tool
from .log import Scope, in_scope
from .values import canonical


def hook_wrapper(event: str, id: str, decision: str, text: str) -> str:
    """The wrapper of a hook decision (§9.2)."""
    return f'<hook event="{event}" id="{id}" decision="{decision}">{text.replace("</hook>", "&lt;/hook>")}</hook>'


def interrupt_wrapper(source: str, text: str) -> str:
    """The wrapper of a delivered interrupt (§9.2)."""
    return f'<interrupt source="{source}">{text.replace("</interrupt>", "&lt;/interrupt>")}</interrupt>'


def result_text(ok: bool, value: Any) -> str:
    """What the model sees of a tool result (§9.3)."""
    if not ok:
        return canonical({"error": value})
    return value if isinstance(value, str) else canonical(value)


def _joined(parts: list[str]) -> str:
    return "".join("\n\n" + p for p in parts)


def render(harness: dict[str, Any], entries: list[dict[str, Any]], scope: Scope) -> dict[str, Any]:
    system = ""
    items: list[dict[str, Any]] = []
    slots: dict[str, dict[str, Any]] = {}  # a call's tool message while its log entries are read (§9.3)
    user_contexts: list[str] = []
    interrupt_contexts: list[str] = []

    for e in entries:
        if not in_scope(e, scope):
            continue
        t = e["type"]
        if t == "system":
            system = e["text"]
        elif t == "user":
            items.append({"role": "user", "text": e["text"] + _joined(user_contexts)})
            user_contexts = []
        elif t == "interrupt":
            items.append({"role": "user", "text": interrupt_wrapper(e["source"], e["text"]) + _joined(interrupt_contexts)})
            interrupt_contexts = []
        elif t == "assistant":
            item = {"role": "assistant", "text": e["text"], "tool_calls": e["tool_calls"]}
            item.update((k, e[k]) for k in ("reasoning", "reasoning_opaque") if k in e)  # the adapter decides (§9)
            items.append(item)
            for c in e["tool_calls"]:
                slot = {"call_id": c["call_id"], "tool": c["tool"], "modifies": [], "contexts": []}
                slots[c["call_id"]] = slot
                items.append({"role": "tool", "slot": slot})
        elif t == "tool_result":
            slot = slots.get(e["call_id"])
            if slot is not None:
                slot["result"] = result_text(True, e["result"]) if e["ok"] else result_text(False, e["error"])
        elif t == "hook":
            event, decision = e["event"], e["decision"]
            text = e.get("text", "args changed") if decision == "modify" else e.get("text")
            wrapper = "" if text is None else hook_wrapper(event, e["hook"], decision, text)
            slot = slots.get(e["call_id"]) if "call_id" in e else None
            if slot is not None:
                if decision == "modify":
                    slot["modifies"].append(wrapper)
                elif decision == "deny":
                    slot["denied"] = wrapper
                elif decision == "replace":
                    slot["replaced"] = wrapper
                elif decision == "add_context":
                    slot["contexts"].append(wrapper)
            elif event == "user_prompt":
                if decision == "add_context":
                    user_contexts.append(wrapper)
                if decision == "deny":
                    user_contexts = []
            elif event == "interrupt":
                if decision == "add_context":
                    interrupt_contexts.append(wrapper)
                if decision == "deny":
                    interrupt_contexts = []
            elif event == "pre_request" and decision == "replace_context":
                items = [{"role": "user", "text": wrapper}]
            elif event in ("pre_request", "stop") and decision in ("add_context", "continue"):
                items.append({"role": "user", "text": wrapper})

    messages: list[dict[str, Any]] = []
    for item in items:
        if item["role"] == "tool":
            s = item["slot"]
            body = s.get("denied", s.get("replaced", s.get("result")))
            if body is None:
                continue  # the call never finished
            message = {"role": "tool", "call_id": s["call_id"], "tool": s["tool"],
                       "text": "".join(m + "\n" for m in s["modifies"]) + body + _joined(s["contexts"])}
        else:
            message = dict(item)
        if message["role"] == "user" and messages and messages[-1]["role"] == "user":
            messages[-1]["text"] += "\n\n" + message["text"]
        else:
            messages.append(message)

    declared = harness.get("tools", {})
    tools = [{"name": name, **shown_tool(name, declared[name])} for name in sorted(declared)]
    return {"system": system, "tools": tools, "messages": messages}
