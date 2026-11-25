"""Rendering (spec §9): the provider-neutral request, a function of the harness and the log."""
from __future__ import annotations

from typing import Any

from .harness import fill, shown_tool, tool_ids
from .log import Scope, in_scope
from .values import canonical


def hook_wrapper(event: str, id: str, decision: str, text: str) -> str:
    """The wrapper of a hook decision (§9.2)."""
    return f'<hook event="{event}" id="{id}" decision="{decision}">{text.replace("</hook>", "&lt;/hook>")}</hook>'


def interrupt_wrapper(source: str, text: str) -> str:
    """The wrapper of a delivered interrupt (§9.2)."""
    return f'<interrupt source="{source}">{text.replace("</interrupt>", "&lt;/interrupt>")}</interrupt>'


def result_text(ok: bool, value: Any, tool_error: str | None = None) -> str:
    """What the model sees of a tool result (§9.3); a failed one through the harness's `tool_error` text, if any (§8.2)."""
    if not ok:
        return canonical({"error": value}) if tool_error is None else fill(tool_error, {"error": value})
    return value if isinstance(value, str) else canonical(value)


def args_text(call: dict[str, Any]) -> str:
    """The argument text of a call (§9.4): its `args_text`, else the canonical form of its `args`."""
    return call["args_text"] if "args_text" in call else canonical(call["args"])


def _joined(parts: list[str]) -> str:
    return "".join("\n\n" + p for p in parts)


def _messages(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The messages the items make (§9.3): tool messages built, user contributions in a row merged. An item marked
    `kept` (kept by a `replace_context`) stays as it was: it never merges into the message before it."""
    messages: list[dict[str, Any]] = []
    for item in items:
        if "slot" in item:
            s = item["slot"]
            body = s.get("denied", s.get("replaced", s.get("result")))
            if body is None:
                continue  # the call never finished
            message = {"role": "tool", "call_id": s["call_id"], "tool": s["tool"],
                       "text": "".join(m + "\n" for m in s["modifies"]) + body + _joined(s["contexts"])}
        else:
            message = dict(item)
        if message["role"] == "user" and messages and messages[-1]["role"] == "user" and not message.get("kept"):
            messages[-1]["text"] += "\n\n" + message["text"]
        else:
            messages.append(message)
    return messages


def render(harness: dict[str, Any], entries: list[dict[str, Any]], scope: Scope) -> dict[str, Any]:
    tool_error = harness.get("texts", {}).get("tool_error")
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
            # A call's `malformed` text is the log's record; the request carries what goes back (§9.4).
            calls = [{k: v for k, v in c.items() if k != "malformed"} for c in e["tool_calls"]]
            item = {"role": "assistant", "text": e["text"], "tool_calls": calls}
            item.update((k, e[k]) for k in ("reasoning", "reasoning_opaque") if k in e)  # the adapter decides (§9)
            items.append(item)
            for c in e["tool_calls"]:
                slot = {"call_id": c["call_id"], "tool": c["tool"], "modifies": [], "contexts": []}
                slots[c["call_id"]] = slot
                items.append({"role": "tool", "slot": slot})
        elif t == "tool_result":
            slot = slots.get(e["call_id"])
            if slot is not None:
                slot["result"] = result_text(True, e["result"]) if e["ok"] else result_text(False, e["error"], tool_error)
        elif t == "hook":
            event, decision = e["event"], e["decision"]
            text = e.get("text", "args changed") if decision == "modify" else e.get("text")
            if text is None:
                wrapper = ""
            else:
                wrapper = text if e.get("wrap") is False else hook_wrapper(event, e["hook"], decision, text)
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
                # The newest `keep` messages stay as they were; the text replaces the ones before them.
                keep = e.get("keep", 0)
                kept = [{**m, "kept": True} for m in _messages(items)[-keep:]] if keep > 0 else []
                items = [{"role": "user", "text": wrapper}, *kept]
            elif event in ("pre_request", "stop") and decision in ("add_context", "continue"):
                items.append({"role": "user", "text": wrapper})

    messages = [{k: v for k, v in m.items() if k != "kept"} for m in _messages(items)]
    declared = harness.get("tools", {})
    tools = [{"name": name, **shown_tool(name, declared[name])} for name in tool_ids(harness)]
    return {"system": system, "tools": tools, "messages": messages}
