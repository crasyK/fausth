"""OpenAI-compatible Chat Completions adapter (host side, spec §9, §13): the neutral request to the
API, the API's answer back to a model response. Texts pass through unchanged; tools keep their ids."""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any

from .engine import InfraFailure
from .values import canonical, parse_json

_RETRY_STATUS = (408, 429, 500, 502, 503, 504)
# Gateways that answer 400 for their own trouble (KIT: "ServiceUnavailable", "Server Connection Error").
_TRANSIENT = ("unavailable", "connection error", "overloaded", "try again", "timeout", "bad gateway")
REASONING_REPLAY = ("none", "turn", "all")


def to_chat(request: dict[str, Any], model: str, extra: dict[str, Any] | None = None,
            reasoning_replay: str = "none") -> dict[str, Any]:
    """The Chat Completions body for a neutral request. `reasoning_replay` says which logged reasoning goes back
    as `reasoning_content` (§9): none, the current turn's (after the last user message), or all of it."""
    if reasoning_replay not in REASONING_REPLAY:
        raise ValueError(f"reasoning_replay must be one of {', '.join(REASONING_REPLAY)}")
    last_user = max((i for i, m in enumerate(request["messages"]) if m["role"] == "user"), default=-1)
    messages: list[dict[str, Any]] = [{"role": "system", "content": request["system"]}] if request["system"] else []
    for i, m in enumerate(request["messages"]):
        if m["role"] == "user":
            messages.append({"role": "user", "content": m["text"]})
        elif m["role"] == "assistant":
            message: dict[str, Any] = {"role": "assistant", "content": m["text"] if m["text"] or not m["tool_calls"] else None}
            if m["tool_calls"]:
                message["tool_calls"] = [
                    {"id": c["call_id"], "type": "function", "function": {"name": c["tool"], "arguments": canonical(c["args"])}}
                    for c in m["tool_calls"]]
            if m.get("reasoning") and (reasoning_replay == "all" or (reasoning_replay == "turn" and i > last_user)):
                message["reasoning_content"] = m["reasoning"]
            messages.append(message)
        else:
            messages.append({"role": "tool", "tool_call_id": m["call_id"], "content": m["text"]})
    body: dict[str, Any] = {"model": model, "messages": messages}
    if request["tools"]:
        body["tools"] = [{"type": "function", "function": {"name": t["name"], "description": t["description"],
                                                           "parameters": t["input"]}} for t in request["tools"]]
    body.update(extra or {})
    return body


def from_chat(body: Any, provider: str) -> dict[str, Any]:
    """The model response (spec §14 shape) for a Chat Completions answer. Raises InfraFailure."""
    choices = body.get("choices") if isinstance(body, dict) else None
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict) \
            or not isinstance(choices[0].get("message"), dict):
        raise InfraFailure("the answer has no message")
    message = choices[0]["message"]
    content = message.get("content")
    out: dict[str, Any] = {"text": content if isinstance(content, str) else ""}
    calls = []
    raw_calls = message.get("tool_calls")
    for c in raw_calls if isinstance(raw_calls, list) else []:
        f = c.get("function") if isinstance(c, dict) else None
        f = f if isinstance(f, dict) else {}
        raw = f.get("arguments")
        if raw is None or raw == "":
            args: Any = {}
        elif isinstance(raw, str):
            try:
                args = parse_json(raw)
            except ValueError:
                args = raw  # not JSON: the engine answers "invalid arguments" to the model
        else:
            args = raw
        calls.append({"tool": f.get("name"), "args": args})
    if calls:
        out["tool_calls"] = calls
    reasoning = message.get("reasoning_content") or message.get("reasoning")
    if isinstance(reasoning, str) and reasoning:
        out["reasoning"] = reasoning
    if message.get("reasoning_details"):
        out["reasoning_opaque"] = {"provider": provider, "data": message["reasoning_details"]}
    return out


class ChatModel:
    """A model transport for one OpenAI-compatible endpoint and model. Retries transient failures
    (the binding's job, §5.4); anything left is an infrastructure failure."""

    def __init__(self, base_url: str, api_key: str, model: str, provider: str, *, extra: dict[str, Any] | None = None,
                 timeout: float = 120, retries: int = 3, reasoning_replay: str = "none") -> None:
        if reasoning_replay not in REASONING_REPLAY:
            raise ValueError(f"reasoning_replay must be one of {', '.join(REASONING_REPLAY)}")
        self.url = base_url.rstrip("/") + "/chat/completions"
        self.api_key, self.model, self.provider = api_key, model, provider
        self.extra, self.timeout, self.retries = extra or {}, timeout, retries
        self.reasoning_replay = reasoning_replay

    def __call__(self, request: dict[str, Any]) -> dict[str, Any]:
        data = json.dumps(to_chat(request, self.model, self.extra, self.reasoning_replay)).encode("utf-8")
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}"}
        for attempt in range(self.retries + 1):
            last = attempt == self.retries
            try:
                with urllib.request.urlopen(urllib.request.Request(self.url, data, headers), timeout=self.timeout) as r:
                    return from_chat(json.loads(r.read().decode("utf-8")), self.provider)
            except urllib.error.HTTPError as e:
                detail = e.read().decode("utf-8", "replace")[:300]
                transient = e.code in _RETRY_STATUS or (e.code == 400 and any(t in detail.lower() for t in _TRANSIENT))
                if last or not transient:
                    raise InfraFailure(f"HTTP {e.code} from {self.model}: {detail}") from None
            except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as e:
                if last:
                    raise InfraFailure(f"{self.model}: {e}") from None
            time.sleep(2 ** attempt)
        raise InfraFailure("unreachable")
