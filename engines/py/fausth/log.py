"""The log (spec §7) and the view that hooks see (§5.3)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .values import canonical


@dataclass(frozen=True)
class Scope:
    """Where a run writes: the top level (depth 0), or a child of the `core_spawn` call `parent_call`."""

    depth: int = 0
    parent_call: str | None = None


TOP = Scope()


class Log:
    """One log for a whole run, child runs included: `seq` counts from 1 across all of it."""

    def __init__(self) -> None:
        self.entries: list[dict[str, Any]] = []

    def append(self, scope: Scope, type: str, members: dict[str, Any]) -> dict[str, Any]:
        """Append an entry written by the run in `scope`. Absent members are left out by the caller
        (None is JSON null, a valid `result`)."""
        entry: dict[str, Any] = {"seq": len(self.entries) + 1, "type": type, **members}
        if scope.depth > 0:
            entry["depth"] = scope.depth
            entry["parent_call"] = scope.parent_call
        self.entries.append(entry)
        return entry

    def text(self) -> str:
        """JSON Lines: one canonical object per line, each line ending with "\\n"."""
        return "".join(canonical(e) + "\n" for e in self.entries)


def call_id(assistant_seq: int, index: int) -> str:
    return f"c{assistant_seq}-{index}"


def in_scope(e: dict[str, Any], scope: Scope) -> bool:
    return e.get("depth", 0) == scope.depth and e.get("parent_call") == scope.parent_call


def view(entries: list[dict[str, Any]], scope: Scope) -> list[dict[str, Any]]:
    """The view of the run in `scope` (§5.3): its finished tool calls and delivered interrupts."""
    calls: dict[str, dict[str, Any]] = {}
    out: list[dict[str, Any]] = []
    for e in entries:
        if not in_scope(e, scope):
            continue
        if e["type"] == "assistant":
            for c in e["tool_calls"]:
                calls[c["call_id"]] = {"step": e["step"], "tool": c["tool"], "args": c["args"]}
        elif e["type"] == "hook" and "call_id" in e:
            call = calls.get(e["call_id"])
            if call is not None and e["decision"] == "modify":
                call["args"] = e["args"]
            if call is not None and e["decision"] == "deny":
                out.append({**call, "ok": False, "error": e["text"]})
        elif e["type"] == "tool_result":
            call = calls.get(e["call_id"])
            if call is None:
                continue
            out.append({**call, "ok": True, "result": e["result"]} if e["ok"] else {**call, "ok": False, "error": e["error"]})
        elif e["type"] == "interrupt":
            out.append({"step": e["step"], "interrupt": {"source": e["source"], "text": e["text"]}})
    return out
