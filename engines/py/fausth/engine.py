"""The run loop (spec §8)."""
from __future__ import annotations

from typing import Any, Callable, Protocol

from .log import TOP, Log, Scope, call_id
from .render import render
from .schema import compile_schema
from .values import canonical, hash


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
        tools = harness.get("tools", {})
        self.inputs = {tid: compile_schema(t["input"]) for tid, t in tools.items() if "input" in t}
        self.outputs = {tid: compile_schema(t["output"]) for tid, t in tools.items() if "output" in t}

    def limit(self, name: str) -> int:
        return self.harness.get("limits", {}).get(name, DEFAULTS[name])

    def append(self, type: str, members: dict[str, Any]) -> dict[str, Any]:
        return self.log.append(self.scope, type, members)

    def run(self) -> None:
        self.append("run_start", {"harness_hash": hash(self.harness), "depth": self.scope.depth})
        try:
            self.append("system", {"text": self.harness["prompt"]})
            while True:
                text = self.host.user()
                if text is None:
                    raise _Ended("stop")
                self.append("user", {"text": text})
                self._turn()
        except _Ended as e:
            self.append("run_end", {"reason": e.reason})
        except InfraFailure:
            self.append("run_end", {"reason": "infra_failure"})

    def _turn(self) -> None:
        while True:
            if self.step == self.limit("max_steps"):
                raise _Ended("limit")
            response = _check_response(self.host.model(render(self.harness, self.log.entries, self.scope)))
            self.step += 1
            seq = len(self.log.entries) + 1
            calls = [{"call_id": call_id(seq, i), "tool": c["tool"], "args": c["args"]}
                     for i, c in enumerate(response.get("tool_calls", []))]
            members = {"step": self.step, "text": response.get("text", ""), "tool_calls": calls}
            members.update((k, response[k]) for k in ("reasoning", "reasoning_opaque") if k in response)
            self.append("assistant", members)
            for call in calls:
                self._tool_call(call)
            if not calls:
                return

    def _tool_call(self, call: dict[str, Any]) -> None:
        if self.tool_calls == self.limit("max_tool_calls"):
            raise _Ended("limit")
        self.tool_calls += 1
        if call["tool"] not in self.harness.get("tools", {}):
            self._result(call, {"ok": False, "error": "invalid arguments: unknown tool"})
            return
        if not self.inputs[call["tool"]](call["args"]):
            self._result(call, {"ok": False, "error": "invalid arguments: does not match the input schema"})
            return
        self._result(call, _check_answer(self.host.call(call["tool"], call["args"]), self.outputs.get(call["tool"])))

    def _result(self, call: dict[str, Any], answer: dict[str, Any]) -> None:
        self.append("tool_result", {"call_id": call["call_id"], "tool": call["tool"], **answer})


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
