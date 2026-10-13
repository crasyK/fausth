"""The ``simulator`` source of the User cell (D14) — mirrors the simulator branch of
TS ``adapters/user-channel.ts``.

A separate model (temperature 0) plays the user. Hidden context goes only into the
simulator's own system prompt; replies must be one JSON object
``{"output": {...}, "set"?: {...}}`` whose ``output`` matches the tool's output schema
and whose ``set`` only names the tool's ``allow_set_keys`` with values of the IR's
declared types. One retry with the reason, then the channel fails closed
(``user_channel_unavailable``).
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Callable

from .adapter_error import AdapterError
from .canonical import canonical_json
from .schema_validate import validate_against_schema

DEFAULT_SIMULATOR_PROMPT = (
    "You are the human user of a software agent. Answer the agent's questions truthfully and briefly, "
    "from your own point of view, using only what you know. Do not perform the agent's task for it."
)

SimulatorPort = Callable[[dict[str, Any]], Any]


def _fail(message: str) -> None:
    raise AdapterError("user_channel_unavailable", f"adapter failure: {message}")


def simulator_system_prompt(
    persona: str,
    hidden: str | None,
    tool: dict[str, Any],
    allow_set_keys: list[str],
    state_types: dict[str, str],
) -> str:
    parts = [persona.strip()]
    if hidden and hidden.strip():
        parts += ["## What you know (private to you; the agent cannot see this)", hidden.strip()]
    desc = tool.get("description")
    output_schema = tool.get("output") if tool.get("output") is not None else {"type": "object"}
    parts += [
        "## Reply protocol",
        f'The agent reaches you through the tool "{tool.get("id")}"' + (f" ({desc})" if desc else "") + ".",
        'Reply with ONLY one JSON object: {"output": <object>' + (', "set": <object>' if allow_set_keys else "") + "}.",
        f'"output" must satisfy this JSON Schema: {canonical_json(output_schema)}',
        (
            '"set" is optional and may only contain these keys: '
            + ", ".join(f"{k} ({state_types[k]})" if k in state_types else k for k in allow_set_keys)
            + "."
        )
        if allow_set_keys
        else 'Do not include "set".',
    ]
    return "\n\n".join(parts)


_FENCE_START = re.compile(r"^```(?:json)?\s*", re.I)
_FENCE_END = re.compile(r"```\s*$")


def parse_simulator_reply(text: str, req: dict[str, Any]) -> tuple[bool, Any]:
    """``(True, {"output", "set"?})`` or ``(False, reason)`` — TS ``parseSimulatorReply``."""
    from .user_channel import check_user_set

    stripped = _FENCE_END.sub("", _FENCE_START.sub("", text.strip())).strip()
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start < 0 or end <= start:
        return False, "reply is not a JSON object"
    try:
        parsed = json.loads(stripped[start : end + 1])
    except ValueError:
        return False, "reply is not valid JSON"
    if not isinstance(parsed, dict):
        return False, "reply must be an object"
    output = parsed.get("output")
    if not isinstance(output, dict):
        return False, "missing output object"
    ok, errors = validate_against_schema(req.get("output_schema"), output)
    if not ok:
        return False, f"output does not match the schema: {'; '.join(errors)}"
    answer: dict[str, Any] = {"output": output}
    if parsed.get("set") is not None:
        if not isinstance(parsed["set"], dict):
            return False, "set must be an object"
        why = check_user_set(parsed["set"], list(req.get("allow_set_keys") or []), req.get("state_types") or {})
        if why:
            return False, why
        answer["set"] = parsed["set"]
    return True, answer


def _persist(entry: dict[str, Any], sink: list[dict[str, Any]] | None) -> None:
    if sink is not None:
        sink.append(entry)
    path = os.environ.get("FAUSTH_USER_TRANSCRIPT")
    if path:
        with open(path, "a", encoding="utf-8", newline="\n") as f:
            f.write(canonical_json(entry) + "\n")


def create_simulator_handler(
    tool: dict[str, Any],
    binding: dict[str, Any],
    *,
    base_dir: str | Path,
    deployment: dict[str, Any],
    allow_set_keys: list[str] | None = None,
    state_types: dict[str, str] | None = None,
    transcript: list[dict[str, Any]] | None = None,
    simulator_port: SimulatorPort | None = None,
) -> Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]]:
    from .mcp import resolve_harness_file

    tool_id = str(tool.get("id"))
    allow = list(allow_set_keys or [])
    types = dict(state_types or {})
    persona = (
        resolve_harness_file(base_dir, binding["system_prompt_file"], "user simulator prompt").read_text(encoding="utf-8")
        if binding.get("system_prompt_file")
        else DEFAULT_SIMULATOR_PROMPT
    )
    hidden = (
        resolve_harness_file(base_dir, binding["context_file"], "user simulator context").read_text(encoding="utf-8")
        if binding.get("context_file")
        else None
    )
    model_cfg = dict(deployment.get("model") or {})
    if binding.get("profile"):
        model_cfg["profile"] = binding["profile"]
    if binding.get("base_url"):
        model_cfg["base_url"] = binding["base_url"]
    if binding.get("api_key_env"):
        model_cfg["api_key_env"] = binding["api_key_env"]
    model_cfg.update({"models": [binding["model"]], "temperature": 0, "max_tokens": binding.get("max_tokens") or 512})
    model_cfg.pop("model", None)
    if model_cfg.get("transport") in (None, "recorded"):
        model_cfg["transport"] = "openai-compatible"
    sim_deployment = {**deployment, "model": model_cfg, "bindings": {}}
    try:
        if simulator_port is not None:
            port = simulator_port(sim_deployment)
        else:
            from .model_transport import create_adapter_from_deployment

            port, _ = create_adapter_from_deployment(sim_deployment)
    except Exception as e:  # noqa: BLE001 - any setup failure means the channel is unavailable
        _fail(f"user simulator for '{tool_id}' unavailable: {e}")
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": simulator_system_prompt(persona, hidden, tool, allow, types)}
    ]
    counter = {"n": 0}

    def handler(args: dict[str, Any], _ctx: dict[str, Any]) -> dict[str, Any]:
        counter["n"] += 1
        seq = counter["n"]
        req = {"output_schema": tool.get("output"), "allow_set_keys": allow, "state_types": types}
        messages.append({"role": "user", "content": f"{tool_id} call #{seq}\narguments: {canonical_json(args or {})}"})
        responses: list[str] = []
        for _ in range(2):
            try:
                proposal = port.propose(messages, [])
            except Exception as e:  # noqa: BLE001 - transport failure is infrastructure, not agent behavior
                messages.pop()
                _fail(f"user simulator for '{tool_id}' failed: {e}")
            text = (proposal.get("message") or "") if proposal.get("type") == "stop" else ""
            responses.append(text)
            messages.append({"role": "assistant", "content": text})
            ok, value = parse_simulator_reply(text, req)
            if ok:
                result: dict[str, Any] = {"output": value["output"]}
                if value.get("set"):
                    result["state_transition"] = {"set": value["set"]}
                _persist(
                    {
                        "tool": tool_id,
                        "call_seq": seq,
                        "source": "simulator",
                        "args": args,
                        "result": result,
                        "simulator": {"model": binding["model"], "responses": responses},
                    },
                    transcript,
                )
                return result
            messages.append(
                {"role": "user", "content": f"Your reply could not be used ({value}). Reply again with only the JSON object."}
            )
        _fail(f"user simulator for '{tool_id}' gave no usable answer for call #{seq}")
        return {}

    return handler
