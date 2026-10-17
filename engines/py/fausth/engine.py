"""The run loop (spec §8) and hooks (§5, §6)."""
from __future__ import annotations

import re
from typing import Any, Callable, Protocol

from .log import TOP, Log, Scope, call_id, view
from .render import hook_wrapper, render
from .schema import compile_schema
from .values import canonical, excerpt, hash


class InfraFailure(Exception):
    pass


class Host(Protocol):
    """What the engine needs from a host (§13). Methods raise InfraFailure when they can't answer."""

    def user(self) -> str | None:
        """The next user message, or None when the conversation is over."""

    def model(self, request: dict[str, Any]) -> Any: ...

    def call(self, id: str, input: Any) -> Any:
        """Call the binding of a tool or handler; the answer is checked by the engine (§3.3)."""

    def interrupts(self, step: int) -> list[dict[str, str]]:
        """Interrupts queued for delivery at this step boundary, in arrival order (§11)."""


DEFAULTS = {"max_steps": 1000, "max_tool_calls": 1000, "max_depth": 1, "max_continues": 3, "max_hook_text": 4000}

# Decisions each event allows besides `allow` (§4), and what a failed built-in check becomes (§6).
ALLOWED = {
    "session_start": ("add_context",),
    "user_prompt": ("deny", "add_context"),
    "pre_request": ("replace_context", "add_context"),
    "pre_tool": ("deny", "modify", "add_context"),
    "post_tool": ("replace", "add_context"),
    "stop": ("continue", "add_context"),
    "interrupt": ("deny", "add_context"),
}
PUSH_BACK = {"pre_tool": "deny", "user_prompt": "deny", "interrupt": "deny", "stop": "continue", "post_tool": "add_context"}
ENDS_CHAIN = ("deny", "continue", "replace_context")
_INDEX = re.compile(r"(?:0|[1-9][0-9]*)\Z")
_NOWHERE = object()


class _Ended(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def run(harness: dict[str, Any], host: Host) -> Log:
    """Run a validated harness to its end and return the log."""
    log = Log()
    _Run(harness, host, log, TOP).run()
    return log


class _Run:
    def __init__(self, harness: dict[str, Any], host: Host, log: Log, scope: Scope) -> None:
        self.harness, self.host, self.log, self.scope = harness, host, log, scope
        self.step = 0  # the current step (§8): model requests made so far
        self.tool_calls = 0
        self.schemas: dict[str, Callable[[Any], bool]] = {}
        for tid, t in harness.get("tools", {}).items():
            for k in ("input", "output"):
                if k in t:
                    self.schemas[f"tools.{tid}.{k}"] = compile_schema(t[k])
        for hid, h in harness.get("handlers", {}).items():
            if "input" in h:
                self.schemas[f"handlers.{hid}.input"] = compile_schema(h["input"])

    def limit(self, name: str) -> int:
        return self.harness.get("limits", {}).get(name, DEFAULTS[name])

    def append(self, type: str, members: dict[str, Any]) -> dict[str, Any]:
        return self.log.append(self.scope, type, members)

    def run(self) -> None:
        self.append("run_start", {"harness_hash": hash(self.harness), "depth": self.scope.depth})
        try:
            contexts = self._chain("session_start", {})
            system = self.harness["prompt"] + "".join(
                "\n\n" + hook_wrapper("session_start", d["hook"]["id"], d["decision"], d["text"]) for d in contexts)
            self.append("system", {"text": system})
            while True:
                text = self.host.user()
                if text is None:
                    raise _Ended("stop")
                if any(d["decision"] == "deny" for d in self._chain("user_prompt", {"message": text})):
                    continue
                self.append("user", {"text": text})
                self._turn()
        except _Ended as e:
            self.append("run_end", {"reason": e.reason})
        except InfraFailure:
            self.append("run_end", {"reason": "infra_failure"})

    def _turn(self) -> None:
        continued = 0
        while True:
            if self.step == self.limit("max_steps"):
                raise _Ended("limit")
            self._chain("pre_request", {})
            response = _check_response(self.host.model(render(self.harness, self.log.entries, self.scope)))
            self.step += 1
            seq = len(self.log.entries) + 1
            calls = [{"call_id": call_id(seq, i), "tool": c["tool"], "args": c["args"]}
                     for i, c in enumerate(response.get("tool_calls", []))]
            text = response.get("text", "")
            members = {"step": self.step, "text": text, "tool_calls": calls}
            members.update((k, response[k]) for k in ("reasoning", "reasoning_opaque") if k in response)
            self.append("assistant", members)
            for call in calls:
                self._tool_call(call)
            if calls:
                continue
            if continued < self.limit("max_continues"):
                if any(d["decision"] == "continue" for d in self._chain("stop", {"message": text, "continued": continued})):
                    continued += 1
                    continue
            return

    def _tool_call(self, call: dict[str, Any]) -> None:
        if self.tool_calls == self.limit("max_tool_calls"):
            raise _Ended("limit")
        self.tool_calls += 1
        tool = call["tool"]
        if tool not in self.harness.get("tools", {}):
            self._result(call, {"ok": False, "error": "invalid arguments: unknown tool"})
            return
        if not self.schemas[f"tools.{tool}.input"](call["args"]):
            self._result(call, {"ok": False, "error": "invalid arguments: does not match the input schema"})
            return
        pre = self._chain("pre_tool", {"call": {"tool": tool, "args": call["args"]}}, call)
        if any(d["decision"] == "deny" for d in pre):
            return
        modified = [d["args"] for d in pre if d["decision"] == "modify"]
        args = modified[-1] if modified else call["args"]
        answer = _check_answer(self.host.call(tool, args), self.schemas.get(f"tools.{tool}.output"))
        self._result(call, answer)
        self._chain("post_tool", {"call": {"tool": tool, "args": args}, "result": answer}, call)

    def _result(self, call: dict[str, Any], answer: dict[str, Any]) -> None:
        self.append("tool_result", {"call_id": call["call_id"], "tool": call["tool"], **answer})

    def _chain(self, event: str, members: dict[str, Any], call: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        """Run the hooks of an event in order (§5.2), log each decision, and return the ones that act."""
        acting: list[dict[str, Any]] = []
        current = members.get("call")
        replaced = None
        key = call["tool"] if call else members.get("interrupt", {}).get("source")
        for hook in self.harness.get("hooks", []):
            if hook["on"] != event or not _matches(hook.get("match", "*"), key):
                continue
            inp: dict[str, Any] = {"event": event, "hook": hook["id"], "with": hook.get("with", {}), "step": self.step,
                                   "view": view(self.log.entries, self.scope)}
            if current is not None:
                inp["call"] = current
            if "result" in members:
                inp["result"] = members["result"]
            if replaced is not None:
                inp["replaced"] = replaced
            for k in ("message", "continued"):
                if k in members:
                    inp[k] = members[k]
            if "interrupt" in members:
                inp["interrupt"] = dict(members["interrupt"])
            if event == "pre_request":
                inp["context"] = render(self.harness, self.log.entries, self.scope)["messages"]

            d = self._decide(hook, event, inp, current["tool"] if current else None)
            where = {"call_id": call["call_id"]} if call else {}
            if d is None:
                self.append("hook", {"hook": hook["id"], "event": event, "decision": "failed", **where})
                if hook.get("on_failure", "end") == "end":
                    raise InfraFailure(f"hook {hook['id']} failed")
                continue
            entry = {"hook": hook["id"], "event": event, "decision": d["decision"]}
            entry.update((k, d[k]) for k in ("text", "args") if k in d)
            self.append("hook", {**entry, **where})
            if d["decision"] == "allow":
                continue
            acting.append(d)
            if d["decision"] == "modify":
                current = {"tool": current["tool"], "args": d["args"]}
            if d["decision"] == "replace":
                replaced = d["text"]
            if d["decision"] in ENDS_CHAIN:
                break
        return acting

    def _decide(self, hook: dict[str, Any], event: str, inp: dict[str, Any], tool: str | None) -> dict[str, Any] | None:
        """One hook's decision (§5.4), or None if the hook failed."""
        def cap(text: str) -> str:
            return excerpt(text, self.limit("max_hook_text"))

        if hook["run"].startswith("core_"):
            w = hook.get("with", {})
            if hook["run"] == "core_context":
                return {"hook": hook, "decision": "add_context", "text": cap(w["text"])}
            failure = _check(hook["run"], w, self.step, inp["view"])
            if failure is None:
                return {"hook": hook, "decision": "allow"}
            return {"hook": hook, "decision": PUSH_BACK[event], "text": cap(failure)}
        schema = self.schemas.get(f"handlers.{hook['run']}.input")
        if schema is not None and not schema(inp):
            return None
        try:
            answer = self.host.call(hook["run"], inp)
        except InfraFailure:
            return None
        if not (isinstance(answer, dict) and answer.get("ok") is True and len(answer) == 2
                and isinstance(answer.get("result"), dict)):
            return None
        out = answer["result"]
        decision = out.get("decision")
        if not isinstance(decision, str) or (decision != "allow" and decision not in ALLOWED[event]):
            return None
        members = sorted(k for k in out if k != "decision")
        if decision == "allow":
            return {"hook": hook, "decision": decision} if not members else None
        if decision == "modify":
            if members not in (["args"], ["args", "text"]):
                return None
            if "text" in out and not isinstance(out["text"], str):
                return None
            if not _is_json(out["args"]) or not self.schemas[f"tools.{tool}.input"](out["args"]):
                return None
            d = {"hook": hook, "decision": decision, "args": out["args"]}
            if "text" in out:
                d["text"] = cap(out["text"])
            return d
        if members != ["text"] or not isinstance(out["text"], str) or not _is_json(out["text"]):
            return None
        return {"hook": hook, "decision": decision, "text": cap(out["text"])}


def _matches(match: Any, key: str | None) -> bool:
    if match == "*":
        return True
    return key is not None and (key in match if isinstance(match, list) else match == key)


def _check(run: str, w: dict[str, Any], step: int, entries: list[dict[str, Any]]) -> str | None:
    """A built-in check (§6): None if it passes, else the failure text."""
    calls = [e for e in entries if "tool" in e]

    def successful(tool: Any) -> Callable[[dict[str, Any]], bool]:
        return lambda e: e["tool"] == tool and e["ok"]

    def seen(e: dict[str, Any]) -> bool:
        return e["step"] < step

    if run == "core_called_since":
        since = -1
        if "since" in w:
            since = max((i for i, e in enumerate(calls) if successful(w["since"])(e)), default=-1)
        if any(successful(w["tool"])(e) and seen(e) for e in calls[since + 1:]):
            return None
        return f"{w['tool']} not called since the last {w['since']}" if since >= 0 else f"{w['tool']} not called yet"
    if run == "core_last_result":
        last = [e for e in calls if successful(w["tool"])(e) and seen(e)]
        if not last:
            return f"{w['tool']} has no successful call yet"
        value = _at(last[-1]["result"], w["path"])
        if value is not _NOWHERE and canonical(value) == canonical(w["eq"]):
            return None
        return f"last {w['tool']} result {w['path']} is not {canonical(w['eq'])}"
    if run == "core_count":
        if sum(1 for e in calls if successful(w["tool"])(e)) < w["max"]:
            return None
        return f"{w['tool']} limit reached ({canonical(w['max'])})"
    return w["text"]  # core_deny


def _at(value: Any, path: str) -> Any:
    """The value at a `.`-separated path of member names and array indexes (§6); _NOWHERE if none."""
    if path == "":
        return value
    v = value
    for segment in path.split("."):
        if isinstance(v, list) and _INDEX.match(segment) and int(segment) < len(v):
            v = v[int(segment)]
        elif isinstance(v, dict) and segment in v:
            v = v[segment]
        else:
            return _NOWHERE
    return v


def _check_response(v: Any) -> dict[str, Any]:
    """A model response as the transport delivered it; anything else breaks the interface."""
    ok = (isinstance(v, dict)
          and isinstance(v.get("text", ""), str)
          and isinstance(v.get("reasoning", ""), str)
          and isinstance(v.get("tool_calls", []), list)
          and all(isinstance(c, dict) and isinstance(c.get("tool"), str) and "args" in c for c in v.get("tool_calls", [])))
    if not ok or not _is_json(v):
        raise InfraFailure("malformed model response")
    return v


def _check_answer(v: Any, output: Callable[[Any], bool] | None) -> dict[str, Any]:
    """A binding's answer (§3.3): `{ok: true, result}` or `{ok: false, error}`, nothing else."""
    if isinstance(v, dict) and v.get("ok") is True and set(v) == {"ok", "result"} and _is_json(v["result"]):
        if output is not None and not output(v["result"]):
            raise InfraFailure("result fails the output schema")
        return {"ok": True, "result": v["result"]}
    if isinstance(v, dict) and v.get("ok") is False and set(v) == {"ok", "error"} and isinstance(v["error"], str) \
            and _is_json(v["error"]):
        return {"ok": False, "error": v["error"]}
    raise InfraFailure("malformed binding answer")


def _is_json(v: Any) -> bool:
    try:
        canonical(v)
        return True
    except ValueError:
        return False
