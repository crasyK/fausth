"""The command-line host (spec §13): a deployment file binds every tool and handler id, names the
model transport, and seeds per-run state for script bindings.

    model:    {base_url, api_key_env, model, provider?, extra?, timeout_s?, reasoning_replay?}
    state:    {...}                        # given to every script binding, shared within the run
    bindings: {<id>: {script: "module:function"} | {recorded: "answers.jsonl"} | {model: {prompt, model?}}}

A script binding is called as `function(args, state)`. It returns the result, or raises ToolError
for a failure the model should see; any other exception is an infrastructure failure (§3.3).
The host ends the run (`host_end`) when the harness's `timeout_ms` has passed (§12.1).
"""
from __future__ import annotations

import importlib
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Callable, Iterator

from .engine import HostEnd, InfraFailure
from .harness import BUILT_INS, read_harness
from .openai import ChatModel
from .values import canonical, parse_json

_FENCE = re.compile(r"\A```(?:json)?\s*\n(.*)\n```\s*\Z", re.S)


class ToolError(Exception):
    """Raised by a script binding: the tool ran and failed (`ok: false`, §3.3)."""


class DeploymentError(ValueError):
    pass


def load_deployment(path: str | Path, harness: dict[str, Any]) -> dict[str, Any]:
    """Read a deployment and reject it if it is malformed or leaves a declared id unbound (§13)."""
    deployment = read_harness(Path(path).read_text("utf-8"))  # YAML 1.2, same reader as harnesses
    if not isinstance(deployment, dict):
        raise DeploymentError("a deployment is a mapping")
    model = deployment.get("model")
    if not (isinstance(model, dict) and all(isinstance(model.get(k), str) for k in ("base_url", "api_key_env", "model"))):
        raise DeploymentError("model needs base_url, api_key_env and model")
    bindings = deployment.get("bindings", {})
    declared = [i for i in (*harness.get("tools", {}), *harness.get("handlers", {})) if i != "core_spawn"]
    unbound = [i for i in declared if i not in bindings]
    if unbound:
        raise DeploymentError(f"unbound: {', '.join(unbound)}")
    for i, b in bindings.items():
        if not (isinstance(b, dict) and len(b) == 1 and next(iter(b)) in ("script", "recorded", "model")):
            raise DeploymentError(f"binding {i}: expected one of script, recorded, model")
        if i in BUILT_INS:
            raise DeploymentError(f"binding {i}: built-ins are not bound")
    return deployment


def _transport(config: dict[str, Any], model: str | None = None) -> ChatModel:
    key = os.environ.get(config["api_key_env"], "")
    if not key:
        raise DeploymentError(f"the environment variable {config['api_key_env']} is not set")
    return ChatModel(config["base_url"], key, model or config["model"], config.get("provider", "openai-compatible"),
                     extra=config.get("extra"), timeout=config.get("timeout_s", 120),
                     reasoning_replay=config.get("reasoning_replay", "none"))


class CliHost:
    """A host for one run: the deployment's bindings, its model, and user messages from a list or stdin."""

    def __init__(self, deployment: dict[str, Any], base: Path, user: Iterator[str], *, timeout_ms: int | None = None,
                 verbose: bool = True) -> None:
        self.model_config = deployment["model"]
        self.transport = _transport(self.model_config)
        self.state: dict[str, Any] = dict(deployment.get("state", {}))
        self.bindings: dict[str, Callable[[Any], Any]] = {}
        for i, b in deployment.get("bindings", {}).items():
            kind, spec = next(iter(b.items()))
            self.bindings[i] = getattr(self, f"_{kind}")(i, spec, base)
        self._user, self.verbose, self.requests = user, verbose, []
        self.deadline = None if timeout_ms is None else time.monotonic() + timeout_ms / 1000
        self.failure: str | None = None  # why the run ended early, for the person running the host

    def _clock(self) -> None:
        if self.deadline is not None and time.monotonic() >= self.deadline:
            self.failure = "timeout_ms has passed"
            raise HostEnd(self.failure)

    def user(self) -> str | None:
        self._clock()
        return next(self._user, None)

    def model(self, request: dict[str, Any]) -> Any:
        self._clock()
        self.requests.append(request)
        try:
            response = self.transport(request)
        except InfraFailure as e:
            self.failure = str(e)
            raise
        if self.verbose:
            for c in response.get("tool_calls", []):
                print(f"  model → {c['tool']} {canonical(c['args'])[:200]}", file=sys.stderr)
            if response.get("text"):
                print(f"  model: {response['text'][:500]}", file=sys.stderr)
        return response

    def call(self, id: str, input: Any) -> Any:
        self._clock()
        try:
            return self.bindings[id](input)
        except InfraFailure as e:
            self.failure = f"{id}: {e}"
            raise

    def interrupts(self, step: int) -> list[dict[str, str]]:
        return []

    def _script(self, id: str, ref: str, base: Path) -> Callable[[Any], Any]:
        module, _, name = ref.partition(":")
        try:
            fn = getattr(importlib.import_module(module), name)
        except (ImportError, AttributeError) as e:
            raise DeploymentError(f"binding {id}: {ref} not found ({e})") from None

        def call(args: Any) -> Any:
            try:
                return {"ok": True, "result": fn(args, self.state)}
            except ToolError as e:
                return {"ok": False, "error": str(e)}
            except Exception as e:  # noqa: BLE001 (a crashing binding is an infrastructure failure)
                raise InfraFailure(f"{ref}: {e!r}") from None
        return call

    def _recorded(self, id: str, path: str, base: Path) -> Callable[[Any], Any]:
        """Answers in order from a JSONL file: `{ok, result}`, `{ok, error}` or `{unreachable: true}`,
        each optionally with this binding's `id` (so lines of a fixture's tools.jsonl fit)."""
        lines = [parse_json(line) for line in (base / path).read_text("utf-8").split("\n") if line.strip()]

        def call(args: Any) -> Any:
            if not lines or lines[0].get("unreachable") is True or lines[0].get("id", id) != id:
                raise InfraFailure(f"{path} has no answer for {id}")
            return {k: v for k, v in lines.pop(0).items() if k != "id"}
        return call

    def _model(self, id: str, spec: dict[str, Any], base: Path) -> Callable[[Any], Any]:
        """Asks a model: the system prompt is `prompt`, the user message the call's input as canonical
        JSON; the answer (JSON, optionally in a ``` fence) is the result."""
        transport = _transport(self.model_config, spec.get("model"))

        def call(args: Any) -> Any:
            answer = transport({"system": spec["prompt"], "tools": [], "messages": [{"role": "user", "text": canonical(args)}]})
            text = answer["text"].strip()
            fenced = _FENCE.match(text)
            try:
                return {"ok": True, "result": parse_json(fenced.group(1) if fenced else text)}
            except ValueError:
                return {"ok": False, "error": "the model's answer is not JSON"}
        return call
