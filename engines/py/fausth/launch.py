"""A binding that launches another Fausth run (spec §13.1): the harness it is handed, with its own log and limits.

A handler bound this way takes the harness from its hook's `with` (`with.harness`: the calling file names its
sub-agent, so all of a system's harnesses are in one resolved document); a tool takes it from its arguments
(`harness`: an orchestrator's model writes a sub-agent at runtime). The launched run inherits none of the
caller's hooks and is not narrowed against the caller's harness (unlike `core_spawn`, §10). It is a top-level run
of its own: one user message, the task the binding makes from its input, and its log is not the caller's.
"""
from __future__ import annotations

from typing import Any, Callable

from .engine import Host, InfraFailure, run
from .harness import fill_host_values, harness_errors
from .log import Log

Binding = Callable[[Any], dict[str, Any]]
INVALID = {"ok": False, "error": "child harness is not valid"}  # core_spawn's words (§10)


def handed_harness(input: Any) -> Any:
    """The harness a binding is handed (§13.1): a hook input's `with.harness`, else a tool's `harness` argument."""
    if isinstance(input, dict) and "event" in input and isinstance(input.get("with"), dict):
        return input["with"].get("harness")
    return input.get("harness") if isinstance(input, dict) else None


def final_text(log: Log) -> str:
    """The text of the run's last top-level assistant entry, "" if none (as `core_spawn` returns it, §10)."""
    return next((e["text"] for e in reversed(log.entries) if e["type"] == "assistant" and "depth" not in e), "")


def harness_binding(host: Host, task: Callable[[Any], Any], *, harness: Callable[[Any], Any] = handed_harness,
                    answer: Callable[[Log], Any] | None = None, binds: Callable[[str], bool] | None = None,
                    on_log: Callable[[Log], None] | None = None, values: dict[str, str] | None = None) -> Binding:
    """A binding (input → answer, §3.3) that runs the harness it is handed on `host`, `task(input)` its only user
    message.

    `harness(input)` picks the handed harness (default `handed_harness`); with `values`, its host values are filled
    first (§2.1). If they can't be, if it isn't valid (§2, §3, §5.1), or if it
    declares an id that `binds` says the launched run's deployment doesn't bind, the answer is `ok: false`,
    `child harness is not valid`: world feedback for a tool, a failed hook for a handler (§5.4). `host` serves the
    launched run (its model transport and its own bindings); its `user()` is never asked. A task that isn't a
    string is an infrastructure failure. `answer(log)` makes the answer from the log of a run that ended with
    `stop`, `limit` or `harness_end`; by default `{ok: true, result: <its final text>}`. `on_log(log)` receives every launched
    run's log, however it ended, for the host to keep. A run that ends with `infra_failure` or `host_end` leaves the
    binding without an answer: InfraFailure, the caller's infrastructure failure (§3.3).
    """
    def call(input: Any) -> dict[str, Any]:
        handed = harness(input)
        if values is not None and isinstance(handed, dict):
            try:
                handed = fill_host_values(handed, values)
            except ValueError:
                return dict(INVALID)
        if harness_errors(handed) or (binds is not None and not all(binds(i) for i in _declared(handed))):
            return dict(INVALID)
        text = task(input)
        if not isinstance(text, str):
            raise InfraFailure("the binding's task is not a string")
        log = run(handed, _OneTask(host, text))
        if on_log is not None:
            on_log(log)
        reason = log.entries[-1]["reason"]
        if reason in ("infra_failure", "host_end"):
            raise InfraFailure(f"the launched run ended with {reason}")
        return answer(log) if answer is not None else {"ok": True, "result": final_text(log)}
    return call


def _declared(harness: dict[str, Any]) -> list[str]:
    """The ids a deployment binds for a harness (§13): its tools and handlers, built-ins aside."""
    return [i for i in (*harness.get("tools", {}), *harness.get("handlers", {})) if i != "core_spawn"]


class _OneTask:
    """The launched run's host: the task is its only user message; everything else is the given host's."""

    def __init__(self, host: Host, task: str) -> None:
        self._host, self._task = host, [task]

    def user(self) -> str | None:
        return self._task.pop() if self._task else None

    def __getattr__(self, name: str) -> Any:
        return getattr(self._host, name)  # model, call, interrupts, and the optional harness and reasons
