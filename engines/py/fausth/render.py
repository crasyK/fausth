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
    `kept` (kept by a `replace_context`) stays as it was: it never merges into the message before it. One marked
    `alone` (the unwrapped text of a `retry`) merges with neither neighbour."""
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
        last = messages[-1] if messages else None
        if (message["role"] == "user" and last is not None and last["role"] == "user" and not message.get("kept")
                and not message.get("alone") and not last.get("alone")):
            last["text"] += "\n\n" + message["text"]
        else:
            messages.append(message)
    return messages


def _replaced(items: list[dict[str, Any]], text: str, keep: int) -> list[dict[str, Any]]:
    """The items after a `replace_context`: one user message, then the newest `keep` messages as they were (§9.3)."""
    kept = [{**m, "kept": True} for m in _messages(items)[-keep:]] if keep > 0 else []
    return [{"role": "user", "text": text}, *kept]


def render(harness: dict[str, Any], entries: list[dict[str, Any]], scope: Scope) -> dict[str, Any]:
    tool_error = harness.get("texts", {}).get("tool_error")
    system = ""
    items: list[dict[str, Any]] = []
    slots: dict[str, dict[str, Any]] = {}  # a call's tool message while its log entries are read (§9.3)
    calls: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {}  # a call as the request shows it, and as logged
    reply: dict[str, Any] | None = None  # the last assistant item and its tool items, for `post_response` (§5.4)
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
            shown = [{k: v for k, v in c.items() if k != "malformed"} for c in e["tool_calls"]]
            item = {"role": "assistant", "text": e["text"], "tool_calls": shown}
            item.update((k, e[k]) for k in ("reasoning", "reasoning_opaque") if k in e)  # the adapter decides (§9)
            tool_items = []
            for c in shown:
                slot = {"call_id": c["call_id"], "tool": c["tool"], "modifies": [], "contexts": []}
                slots[c["call_id"]] = slot
                calls[c["call_id"]] = (c, {k: v for k, v in c.items() if k in ("args", "args_text")})
                tool_items.append({"role": "tool", "slot": slot})
            items.append(item)
            items.extend(tool_items)
            reply = {"item": item, "tools": tool_items}
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
            if event == "pre_check":
                if decision == "modify" and e["call_id"] in calls:
                    # `shown: modified` puts the modified arguments and their text in later requests; `model` keeps
                    # (or puts back) the model's (§5.4).
                    c, model = calls[e["call_id"]]
                    c.pop("args_text", None)
                    if e["shown"] == "modified":
                        c["args"] = e["args"]
                        if "args_text" in e:
                            c["args_text"] = e["args_text"]
                    else:
                        c.update(model)
                continue
            if event == "post_response":
                if reply is not None and decision == "modify":
                    # The listed calls, in that order, under their names; their tool messages likewise (§9.3).
                    item, tool_items = reply["item"], reply["tools"]
                    by_id = {c["call_id"]: (c, ti) for c, ti in zip(item["tool_calls"], tool_items)}
                    start = next(i for i, x in enumerate(items) if x is item)
                    new_calls, new_tools = [], []
                    for m in e["calls"]:
                        c, ti = by_id[m["call_id"]]
                        c["tool"] = m["tool"]
                        ti["slot"]["tool"] = m["tool"]
                        new_calls.append(c)
                        new_tools.append(ti)
                    item["tool_calls"] = new_calls
                    items[start + 1:start + 1 + len(tool_items)] = new_tools
                    reply["tools"] = new_tools
                elif reply is not None and decision == "retry":
                    item, tool_items = reply["item"], reply["tools"]
                    start = next(i for i, x in enumerate(items) if x is item)
                    del items[start:start + 1 + len(tool_items)]
                    if "replace_context" in e:
                        rc = e["replace_context"]
                        rtext = rc["text"] if rc.get("wrap") is False else hook_wrapper(
                            event, e["hook"], "replace_context", rc["text"])
                        items = _replaced(items, rtext, rc.get("keep", 0))
                    if e.get("keep_reply") is True:
                        items.extend([item, *tool_items])
                    if "text" in e:
                        items.append({"role": "user", "text": wrapper, **({"alone": True} if e.get("wrap") is False else {})})
                    reply = None
                continue
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
                # A `replace` is in the `user` entry already.
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
                items = _replaced(items, wrapper, e.get("keep", 0))
            elif event in ("pre_request", "stop") and decision in ("add_context", "continue"):
                items.append({"role": "user", "text": wrapper})

    messages = [{k: v for k, v in m.items() if k not in ("kept", "alone")} for m in _messages(items)]
    declared = harness.get("tools", {})
    tools = [{"name": name, **shown_tool(name, declared[name])} for name in tool_ids(harness)]
    return {"system": system, "tools": tools, "messages": messages}
