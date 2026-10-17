"""The replay host (spec §14): answers a run from a fixture's recorded files."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .engine import HostEnd, InfraFailure, run
from .harness import harness_errors, read_harness
from .values import canonical, parse_json


def _lines(path: Path) -> list[Any]:
    if not path.exists():
        return []
    return [parse_json(line) for line in path.read_text("utf-8").split("\n") if line.strip()]


def replay(directory: str | Path) -> tuple[str, str]:
    """Replay a fixture directory; returns the log and the rendered requests as JSON Lines."""
    d = Path(directory)
    harness = read_harness((d / "harness.json").read_text("utf-8"))
    errors = harness_errors(harness)
    if errors:
        raise ValueError(f"{d}: invalid harness: {'; '.join(errors)}")
    model, tools, user, pending, reloads = (
        _lines(d / n) for n in ("model.jsonl", "tools.jsonl", "user.jsonl", "interrupts.jsonl", "reloads.jsonl"))
    requests: list[str] = []

    class _Host:
        def user(self) -> str | None:
            if not user:
                return None
            line = user.pop(0)
            if line.get("end") is True:
                raise HostEnd("user.jsonl ends the run")
            if not isinstance(line.get("text"), str):
                raise InfraFailure("a user.jsonl line has no text")
            return line["text"]

        def model(self, request: dict[str, Any]) -> Any:
            requests.append(canonical(request) + "\n")
            if not model:
                raise InfraFailure("model.jsonl has no more responses")
            line = model.pop(0)
            if line.get("end") is True:
                raise HostEnd("model.jsonl ends the run")
            if "error" in line:
                raise InfraFailure(str(line["error"]))
            return line

        def call(self, id: str, input: Any) -> Any:
            line = tools.pop(0) if tools else None
            if line is None or line.get("id") != id or line.get("unreachable") is True:
                raise InfraFailure(f"tools.jsonl has no answer for {id}")
            return {k: v for k, v in line.items() if k != "id"}

        def interrupts(self, step: int) -> list[dict[str, str]]:
            due = [line for line in pending if line["step"] <= step]
            pending[:] = [line for line in pending if line["step"] > step]
            return [{"source": line.get("source"), "text": line.get("text")} for line in due]

        def harness(self, step: int) -> Any:
            if not reloads or reloads[0]["step"] > step:
                return None
            return reloads.pop(0)["harness"]

    log = run(harness, _Host())
    return log.text(), "".join(requests)
