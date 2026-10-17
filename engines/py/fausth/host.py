"""The command-line host (spec §13): a deployment file binds every tool and handler id, names the
model transport, and seeds per-run state for script bindings.

    model:    {base_url, api_key_env, model, provider, extra?}
    state:    {...}                        # given to every script binding, shared within the run
    bindings: {<id>: {script: "module:function"} | {recorded: "answers.jsonl"} | {model: {prompt, model?}}}

A script binding is called as `function(args, state)`. It returns the result, or raises ToolError
for a failure the model should see; any other exception is an infrastructure failure (§3.3).
"""
from __future__ import annotations

import importlib
import os
import sys
from pathlib import Path
from typing import Any, Callable, Iterator

from .engine import InfraFailure
from .harness import BUILT_INS, read_harness
from .openai import ChatModel
from .values import canonical, parse_json


class ToolError(Exception):
    """Raised by a script binding: the tool ran and failed (`ok: false`, §3.3)."""


class DeploymentError(ValueError):
    pass


def load_deployment(path: str | Path, harness: dict[str, Any]) -> dict[str, Any]:
    """Read a deployment and reject it if a declared id is unbound (§13)."""
    deployment = read_harness(Path(path).read_text("utf-8"))  # YAML 1.2, same reader as harnesses
    if not isinstance(deployment, dict):
        raise DeploymentError("a deployment is a mapping")
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
    key = os.environ.get(config.get("api_key_env", ""), "")
    if not key:
        raise DeploymentError(f"the environment variable {config.get('api_key_env')} is not set")
    return ChatModel(config["base_url"], key, model or config["model"], config.get("provider", "openai-compatible"),
                     extra=config.get("extra"), timeout=config.get("timeout_s", 120))


class CliHost:
    """A host for one run: the deployment's bindings, its model, and user messages from a list or stdin."""

    def __init__(self, deployment: dict[str, Any], base: Path, user: Iterator[str], *, verbose: bool = True) -> None:
        self.model_config = deployment["model"]
        self.transport = _transport(self.model_config)
        self.state: dict[str, Any] = dict(deployment.get("state", {}))
        self.bindings: dict[str, Callable[[Any], Any]] = {}
        for i, b in deployment.get("bindings", {}).items():
            kind, spec = next(iter(b.items()))
            self.bindings[i] = getattr(self, f"_{kind}")(spec, base)
        self._user, self.verbose, self.requests = user, verbose, []
        self.failure: str | None = None  # the last infrastructure failure, for the person running the host

    def user(self) -> str | None:
        return next(self._user, None)

    def model(self, request: dict[str, Any]) -> Any:
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
        try:
            return self.bindings[id](input)
        except InfraFailure as e:
            self.failure = f"{id}: {e}"
            raise

    def interrupts(self, step: int) -> list[dict[str, str]]:
        return []

    def _script(self, ref: str, base: Path) -> Callable[[Any], Any]:
        module, _, name = ref.partition(":")
        fn = getattr(importlib.import_module(module), name)

        def call(args: Any) -> Any:
            try:
                return {"ok": True, "result": fn(args, self.state)}
            except ToolError as e:
                return {"ok": False, "error": str(e)}
            except Exception as e:  # noqa: BLE001 (a crashing binding is an infrastructure failure)
                raise InfraFailure(f"{ref}: {e!r}") from None
        return call

    def _recorded(self, path: str, base: Path) -> Callable[[Any], Any]:
        lines = [parse_json(line) for line in (base / path).read_text("utf-8").split("\n") if line.strip()]

        def call(args: Any) -> Any:
            if not lines or lines[0].get("unreachable") is True:
                raise InfraFailure(f"{path} has no answer left")
            return lines.pop(0)
        return call

    def _model(self, spec: dict[str, Any], base: Path) -> Callable[[Any], Any]:
        transport = _transport(self.model_config, spec.get("model"))

        def call(args: Any) -> Any:
            answer = transport({"system": spec["prompt"], "tools": [], "messages": [{"role": "user", "text": canonical(args)}]})
            try:
                return {"ok": True, "result": parse_json(answer["text"].strip())}
            except ValueError:
                return {"ok": False, "error": "the model's answer is not JSON"}
        return call
