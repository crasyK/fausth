"""The User cell (D14) for the Python host — mirrors TS adapters/user-channel.ts.

Tools whose output must come from the user are bound with
``bindings: {<tool>: {user: {source: recorded|simulator|human, ...}}}`` and are never
answered from the acting model's own arguments.

Recorded answers (Track A, deterministic) — JSONL, one entry per answer, each consumed
at most once::

    {"tool": "user.ask", "call_seq": 1, "args": {"question": "..."},
     "result": {"output": {"answer": "..."}, "state_transition": {"set": {"clarified": 1}}}}

``call_seq`` (1-based count of calls to this tool) and ``args`` (canonical-JSON equality
with the call args) are optional match keys. The fausth-py host supports ``recorded`` and
``human`` (callback or TTY); ``simulator`` needs a live model transport and is available
in the TS host only — binding it here fails at bind time instead of faking answers.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Callable

from .adapter_error import AdapterError
from .canonical import canonical_json
from .mcp import resolve_harness_file

USER_CHANNEL_SOURCES = ("recorded", "simulator", "human")

ToolHandler = Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]]
HumanAnswer = Callable[[dict[str, Any]], dict[str, Any]]


def is_user_channel_binding(binding: Any) -> bool:
    return isinstance(binding, dict) and "user" in binding


def _fail(message: str) -> None:
    raise AdapterError("user_channel_unavailable", f"adapter failure: {message}")


def parse_user_channel_binding(tool_id: str, raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise AdapterError("adapter_unresolved", f"adapter failure: bindings.{tool_id}.user must be an object")
    source = raw.get("source")
    if source not in USER_CHANNEL_SOURCES:
        raise AdapterError(
            "adapter_unresolved",
            f"adapter failure: bindings.{tool_id}.user.source must be one of {'|'.join(USER_CHANNEL_SOURCES)}",
        )
    for k in ("answers", "model", "system_prompt_file", "context_file", "profile", "base_url", "api_key_env"):
        if k in raw and (not isinstance(raw[k], str) or not raw[k]):
            raise AdapterError("adapter_unresolved", f"adapter failure: bindings.{tool_id}.user.{k} must be a string")
    if source == "recorded" and not raw.get("answers"):
        raise AdapterError("adapter_unresolved", f"adapter failure: bindings.{tool_id}.user recorded source requires answers")
    if source == "simulator" and not raw.get("model"):
        raise AdapterError("adapter_unresolved", f"adapter failure: bindings.{tool_id}.user simulator source requires model")
    return dict(raw)


def _as_envelope(raw: Any, where: str) -> dict[str, Any]:
    if not isinstance(raw, dict):
        _fail(f"{where}: result must be an object")
    output = raw.get("output")
    if not isinstance(output, dict):
        _fail(f"{where}: result.output must be an object")
    out: dict[str, Any] = {"output": output}
    if "state_transition" in raw:
        st = raw["state_transition"]
        if not isinstance(st, dict) or ("set" in st and not isinstance(st["set"], dict)):
            _fail(f"{where}: state_transition must be an object with an object 'set'")
        out["state_transition"] = st
    return out


def _load_answers(base_dir: str | Path, rel: str) -> list[dict[str, Any]]:
    path = resolve_harness_file(base_dir, rel, "user answers")
    out: list[dict[str, Any]] = []
    for i, line in enumerate(re.split(r"\r?\n", path.read_bytes().decode("utf-8")), start=1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as e:
            raise AdapterError("adapter_unresolved", f"adapter failure: invalid user answers line {i} in {rel}") from e
        if not isinstance(row, dict) or not isinstance(row.get("tool"), str):
            raise AdapterError("adapter_unresolved", f"adapter failure: user answers line {i} needs a tool")
        seq = row.get("call_seq")
        if seq is not None and (not isinstance(seq, int) or isinstance(seq, bool) or seq < 1):
            raise AdapterError("adapter_unresolved", f"adapter failure: user answers line {i} call_seq must be an integer >= 1")
        if "args" in row and not isinstance(row["args"], dict):
            raise AdapterError("adapter_unresolved", f"adapter failure: user answers line {i} args must be an object")
        out.append(
            {
                "tool": row["tool"],
                "call_seq": seq,
                "args": row.get("args"),
                "result": _as_envelope(row.get("result"), f"user answers line {i}"),
            }
        )
    return out


def _persist(entry: dict[str, Any], sink: list[dict[str, Any]] | None) -> None:
    if sink is not None:
        sink.append(entry)
    path = os.environ.get("FAUSTH_USER_TRANSCRIPT")
    if path:
        with open(path, "a", encoding="utf-8", newline="\n") as f:
            f.write(canonical_json(entry) + "\n")


def coerce_human_answer(text: str, schema: dict[str, Any] | None) -> dict[str, Any] | None:
    """Same mapping as TS coerceHumanAnswer."""
    t = text.strip()
    if t.startswith("{"):
        try:
            parsed = json.loads(t)
        except json.JSONDecodeError:
            return None
        if isinstance(parsed, dict):
            if isinstance(parsed.get("output"), dict):
                out: dict[str, Any] = {"output": parsed["output"]}
                if isinstance(parsed.get("set"), dict):
                    out["set"] = parsed["set"]
                return out
            return {"output": parsed}
        return None
    props = (schema or {}).get("properties") or {}
    required = (schema or {}).get("required")
    if not isinstance(required, list):
        required = list(props.keys())
    if len(required) != 1:
        return None
    key = required[0]
    typ = (props.get(key) or {}).get("type")
    if typ in (None, "string"):
        return {"output": {key: t}}
    if typ in ("integer", "number", "boolean"):
        yes = re.fullmatch(r"(?i)(y|yes|1|true)", t) is not None
        no = re.fullmatch(r"(?i)(n|no|0|false)", t) is not None
        if not yes and not no:
            return None
        return {"output": {key: yes if typ == "boolean" else (1 if yes else 0)}}
    return None


def _tty_human_answer(req: dict[str, Any]) -> dict[str, Any]:
    if not sys.stdin.isatty():
        _fail(f"user channel '{req['tool']}' (human) needs an interactive terminal or a human_answer callback")
    for _ in range(3):
        sys.stderr.write(
            f"\n--- the agent asks you ({req['tool']} #{req['call_seq']}) ---\n{canonical_json(req['args'])}\n"
            'Your answer (text, yes/no, or JSON {"output":...,"set":...}): '
        )
        sys.stderr.flush()
        coerced = coerce_human_answer(sys.stdin.readline(), req.get("output_schema"))
        if coerced:
            return coerced
        sys.stderr.write("Could not map that answer to the tool output schema; try again.\n")
    _fail(f"user channel '{req['tool']}': no usable human answer")
    return {}


def create_user_channel_handler(
    tool: dict[str, Any],
    binding: dict[str, Any],
    *,
    base_dir: str | Path,
    allow_set_keys: list[str] | None = None,
    transcript: list[dict[str, Any]] | None = None,
    human_answer: HumanAnswer | None = None,
) -> ToolHandler:
    tool_id = str(tool.get("id"))
    source = binding.get("source")
    counter = {"n": 0}

    if source == "recorded":
        answers = _load_answers(base_dir, binding["answers"])
        used: set[int] = set()

        def recorded(args: dict[str, Any], _ctx: dict[str, Any]) -> dict[str, Any]:
            counter["n"] += 1
            seq = counter["n"]
            args_canon = canonical_json(args or {})
            for i, a in enumerate(answers):
                if i in used or a["tool"] != tool_id:
                    continue
                if a["call_seq"] is not None and a["call_seq"] != seq:
                    continue
                if a["args"] is not None and canonical_json(a["args"]) != args_canon:
                    continue
                used.add(i)
                result = json.loads(json.dumps(a["result"]))
                _persist(
                    {"tool": tool_id, "call_seq": seq, "source": "recorded", "args": args, "result": result},
                    transcript,
                )
                return result
            _fail(f"no recorded user answer for '{tool_id}' call #{seq}")
            return {}

        return recorded

    if source == "human":
        ask = human_answer or _tty_human_answer

        def human(args: dict[str, Any], _ctx: dict[str, Any]) -> dict[str, Any]:
            counter["n"] += 1
            req = {
                "tool": tool_id,
                "call_seq": counter["n"],
                "args": args,
                "description": tool.get("description"),
                "output_schema": tool.get("output"),
                "allow_set_keys": list(allow_set_keys or []),
            }
            answer = ask(req)
            if not isinstance(answer, dict) or not isinstance(answer.get("output"), dict):
                _fail(f"user channel '{tool_id}': human answer must provide an output object")
            result: dict[str, Any] = {"output": answer["output"]}
            if isinstance(answer.get("set"), dict) and answer["set"]:
                result["state_transition"] = {"set": answer["set"]}
            _persist(
                {"tool": tool_id, "call_seq": counter["n"], "source": "human", "args": args, "result": result},
                transcript,
            )
            return result

        return human

    raise AdapterError(
        "user_channel_unavailable",
        f"adapter failure: user channel source '{source}' for '{tool_id}' is not available in fausth-py "
        "(recorded/human only; the simulator needs the TS host's live model transport)",
    )
