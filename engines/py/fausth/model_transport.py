"""OpenAI-compatible Chat Completions transport — Python twin of TS
``model/transports/openai-compatible.ts`` + ``model/resolve.ts`` + profiles.

The Python host uses it for live helpers that must behave exactly like the TS
host (today: the D14 user simulator). Infra failures raise
:class:`ModelInfraError`; model-protocol failures come back as ``invalid``
proposals with a reason from :data:`MODEL_PROTOCOL_INVALID_REASONS`. API keys
are read from the environment only and never logged.
"""
from __future__ import annotations

import json
import math
import os
import re
import socket
import time
import urllib.error
import urllib.request
from email.utils import parsedate_to_datetime
from typing import Any, Callable

DEFAULT_MODEL_TIMEOUT_MS = 120_000
DEFAULT_MAX_ATTEMPTS = 4
DEFAULT_RETRY_BASE_MS = 500
MAX_RETRY_AFTER_MS = 60_000
RAW_MAX_CODE_POINTS = 1000
INT53_MAX = 9007199254740991

MODEL_INFRA_ERROR_KINDS = (
    "timeout",
    "rate_limit",
    "server_error",
    "network",
    "auth",
    "bad_request",
    "model_unavailable",
)

#: Closed set of model-protocol failure reasons carried by ``invalid`` proposals (D12).
MODEL_PROTOCOL_INVALID_REASONS = (
    "empty_choices",
    "unknown_transport_tool",
    "invalid_tool_arguments_json",
    "tool_arguments_not_object",
    "tool_arguments_non_canonical",
    "multiple_tool_calls",
    "empty_proposal",
)


class ModelInfraError(RuntimeError):
    """Infrastructure failure: no model answer was obtained."""

    infra = True

    def __init__(self, kind: str, message: str, *, status: int | None = None, model: str | None = None) -> None:
        text = f"RATE_LIMIT: {message}" if kind == "rate_limit" and not message.startswith("RATE_LIMIT") else message
        super().__init__(text)
        self.kind = kind
        self.status = status
        self.model = model
        self.code = 2 if kind == "rate_limit" else None


_KEY_LIKE_RE = re.compile(r"(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}|\bsk-(?:or-)?[A-Za-z0-9_-]{8,}\b")


def bound_provider_text(text: Any, max_code_points: int = 500) -> str:
    """Bound + redact provider text before it lands in an error message (D13)."""
    redacted = _KEY_LIKE_RE.sub(lambda m: f"{m.group(1)}[REDACTED]" if m.group(1) else "[REDACTED]", str(text or ""))
    return redacted[:max_code_points] + "…" if len(redacted) > max_code_points else redacted


def _cap(s: str, n: int = RAW_MAX_CODE_POINTS) -> str:
    return s[:n] + "…" if len(s) > n else s


DEFAULT_CAPABILITIES: dict[str, Any] = {
    "chat_completions": True,
    "native_tools": "unknown",
    "parallel_tools": "unknown",
    "structured_output": "unknown",
    "streaming": "unknown",
    "reasoning_details": "unknown",
    "max_tokens_field": "max_tokens",
    "tool_choice": "unknown",
    "parallel_tool_calls_param": "unknown",
}

PROFILES: dict[str, dict[str, Any]] = {
    "generic": {"id": "generic", "defaultApiKeyEnv": "OPENAI_API_KEY", "capabilities": dict(DEFAULT_CAPABILITIES)},
    "kit-scc": {
        "id": "kit-scc",
        "defaultBaseUrl": "https://ki-toolbox.scc.kit.edu/api/v1",
        "defaultApiKeyEnv": "KIT_AI_API_KEY",
        "capabilities": {
            **DEFAULT_CAPABILITIES,
            "native_tools": "unknown",
            "tool_choice": "unknown",
            "reasoning_details": "preserve",
        },
        "compatibility": {
            "preserve_response_fields": ["reasoning_details"],
            "prohibited_model_aliases": ["standard-external", "standard-local"],
            "gateway_system_prompt": "prohibited",
        },
    },
    "openrouter": {
        "id": "openrouter",
        "defaultBaseUrl": "https://openrouter.ai/api/v1",
        "defaultApiKeyEnv": "OPENROUTER_API_KEY",
        "defaultModels": [
            "cohere/north-mini-code:free",
            "nvidia/nemotron-3-super-120b-a12b:free",
            "google/gemma-4-26b-a4b-it:free",
        ],
        "defaultHeaders": {"HTTP-Referer": "https://github.com/crasyK/fausth", "X-Title": "Faust Harness"},
        "capabilities": {**DEFAULT_CAPABILITIES, "native_tools": True, "tool_choice": True},
    },
    "ollama": {
        "id": "ollama",
        "defaultBaseUrl": "http://127.0.0.1:11434/v1",
        "defaultApiKeyEnv": "OLLAMA_API_KEY",
        "defaultApiKey": "ollama",
        "defaultModels": ["llama3.2"],
        "capabilities": {**DEFAULT_CAPABILITIES, "native_tools": "unknown", "tool_choice": "unknown"},
    },
}


def resolve_profile(pid: str | None = None) -> dict[str, Any]:
    if not pid:
        return PROFILES["generic"]
    if pid in PROFILES:
        return PROFILES[pid]
    raise ValueError(f"Unknown provider profile: {pid}")


def resolve_api_key(env_name: str, fallback: str | None = None) -> str:
    """API keys come from the environment only — never from deployment YAML literals."""
    v = os.environ.get(env_name, fallback)
    if not v:
        raise ValueError(f"API key env {env_name} is not set (deployment must use api_key_env)")
    return v


def filter_models_by_data_policy(models: list[str], deployment: dict[str, Any]) -> list[str]:
    require = ((deployment.get("data_policy") or {}).get("require") or {}).get("residency")
    if not require:
        return models
    catalog = deployment.get("model_catalog")
    if not isinstance(catalog, list) or not catalog:
        raise ValueError(
            f"data_policy.require.residency={require} needs an admin-authored model_catalog with "
            "policy.residency per model (fail closed: no catalog, no model)"
        )
    allowed = {
        e.get("id")
        for e in catalog
        if isinstance(e, dict)
        and ((e.get("policy") or {}).get("residency") or (e.get("policy") or {}).get("processing_location")) == require
    }
    filtered = [m for m in models if m in allowed]
    if not filtered:
        raise ValueError(f"No models satisfy data_policy.require.residency={require}")
    return filtered


#: (url, headers, body, timeout_s) -> (status, headers, text); raises socket.timeout / OSError.
HttpPost = Callable[[str, dict[str, str], bytes, float], tuple[int, dict[str, str], str]]


def _urllib_post(url: str, headers: dict[str, str], body: bytes, timeout_s: float) -> tuple[int, dict[str, str], str]:
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as res:  # noqa: S310 - operator-configured endpoint
            return res.status, {k.lower(): v for k, v in res.headers.items()}, res.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace") if e.fp else ""
        return e.code, {k.lower(): v for k, v in (e.headers or {}).items()}, text


_QUOTA_RE = re.compile(r"daily|per[-\s]?day|quota", re.I)
_QUOTA_OR_LIMIT_RE = re.compile(r"daily|per[-\s]?day|quota|rate.?limit", re.I)


def _has_non_canonical_number(v: Any) -> bool:
    if isinstance(v, bool):
        return False
    if isinstance(v, float):
        return not (math.isfinite(v) and v.is_integer()) or abs(v) > INT53_MAX
    if isinstance(v, int):
        return abs(v) > INT53_MAX
    if isinstance(v, list):
        return any(_has_non_canonical_number(x) for x in v)
    if isinstance(v, dict):
        return any(_has_non_canonical_number(x) for x in v.values())
    return False


class OpenAICompatibleAdapter:
    """Canonical OpenAI-compatible Chat Completions transport (one tool per step)."""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        models: list[str],
        temperature: float | None = None,
        max_tokens: int | None = None,
        headers: dict[str, str] | None = None,
        capabilities: dict[str, Any] | None = None,
        preserve_response_fields: list[str] | None = None,
        timeout_ms: int | None = None,
        max_attempts: int | None = None,
        retry_base_ms: int | None = None,
        post: HttpPost | None = None,
        sleep: Callable[[float], None] | None = None,
    ) -> None:
        self.base_url = base_url
        self._api_key = api_key
        self.models = list(models)
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.headers = dict(headers or {})
        self.capabilities = capabilities or {}
        self.preserve_response_fields = list(preserve_response_fields or [])
        self.timeout_ms = timeout_ms if isinstance(timeout_ms, int) and timeout_ms > 0 else DEFAULT_MODEL_TIMEOUT_MS
        self.max_attempts = max(1, max_attempts or DEFAULT_MAX_ATTEMPTS)
        self.retry_base_ms = DEFAULT_RETRY_BASE_MS if retry_base_ms is None else retry_base_ms
        self._post = post or _urllib_post
        self._sleep = sleep or time.sleep
        self.last_model_used = ""
        self._parallel_flag_rejected: set[str] = set()

    def __repr__(self) -> str:  # never show the key
        return f"OpenAICompatibleAdapter(base_url={self.base_url!r}, models={self.models!r})"

    def propose(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | None = None,
    ) -> dict[str, Any]:
        id_map: dict[str, str] = {}
        wire_tools = []
        for i, t in enumerate(tools or []):
            name = f"faust_tool_{i + 1:04d}"
            id_map[name] = t["id"]
            params = t.get("input") if isinstance(t.get("input"), dict) and t.get("input") else {"type": "object", "additionalProperties": True}
            wire_tools.append(
                {"type": "function", "function": {"name": name, "description": t.get("description") or t["id"], "parameters": params}}
            )
        last_err: ModelInfraError | None = None
        for model in self.models:
            ok, value, fallback = self._propose_with_model(model, messages, wire_tools, id_map, tool_choice)
            if ok:
                return value
            last_err = value
            if not fallback:
                raise value
        raise last_err or ModelInfraError("model_unavailable", "no models configured")

    def _propose_with_model(
        self,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        id_map: dict[str, str],
        tool_choice_in: str | None,
    ) -> tuple[bool, Any, bool]:
        caps = self.capabilities
        offer_tools = bool(tools) and caps.get("native_tools") is not False
        tool_choice = "required" if tool_choice_in == "required" else "auto"
        tried_auto_after_reject = False
        tried_auto_after_empty = False
        last_err: ModelInfraError | None = None
        attempt = 0

        def backoff(wait_ms: float | None = None) -> None:
            nonlocal attempt
            attempt += 1
            if attempt < self.max_attempts:
                ms = wait_ms if wait_ms is not None else self.retry_base_ms * 2 ** (attempt - 1)
                if ms > 0:
                    self._sleep(ms / 1000.0)

        while attempt < self.max_attempts:
            send_parallel = (
                offer_tools and caps.get("parallel_tool_calls_param") is not False and model not in self._parallel_flag_rejected
            )
            body: dict[str, Any] = {
                "model": model,
                "temperature": 0 if self.temperature is None else self.temperature,
                caps.get("max_tokens_field") or "max_tokens": 1024 if self.max_tokens is None else self.max_tokens,
                "messages": [self._wire(m, model) for m in messages],
            }
            if offer_tools:
                body["tools"] = tools
                if caps.get("tool_choice") is not False:
                    body["tool_choice"] = tool_choice
                if send_parallel:
                    body["parallel_tool_calls"] = False
            url = self.base_url.rstrip("/") + "/chat/completions"
            headers = {"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json", **self.headers}
            try:
                status, res_headers, text = self._post(
                    url, headers, json.dumps(body, ensure_ascii=False).encode("utf-8"), self.timeout_ms / 1000.0
                )
            except (socket.timeout, TimeoutError) as e:
                last_err = ModelInfraError("timeout", f"model request timed out after {self.timeout_ms}ms ({model})", model=model)
                del e
                backoff()
                continue
            except OSError as e:
                last_err = ModelInfraError(
                    "network", f"model request failed ({model}): {bound_provider_text(str(e))}", model=model
                )
                backoff()
                continue
            if not 200 <= status < 300:
                request_fixable = 400 <= status < 500 and status not in (401, 402, 403, 404, 408, 429)
                if request_fixable and send_parallel and re.search(r"parallel_tool_calls", text, re.I):
                    self._parallel_flag_rejected.add(model)
                    continue
                if (
                    request_fixable
                    and body.get("tool_choice") == "required"
                    and not tried_auto_after_reject
                    and re.search(r"tool_choice|required|unsupported|invalid", text, re.I)
                ):
                    tool_choice = "auto"
                    tried_auto_after_reject = True
                    continue
                err, retry, fallback, wait_ms = self._classify_http(status, res_headers, text, model)
                if retry:
                    last_err = err
                    backoff(wait_ms)
                    continue
                return False, err, fallback
            try:
                data = json.loads(text)
            except ValueError:
                last_err = ModelInfraError("server_error", f"malformed (non-JSON) response body from {model}", status=status, model=model)
                backoff()
                continue
            if isinstance(data, dict) and data.get("error") and not isinstance(data.get("choices"), list):
                err_obj = data["error"] if isinstance(data["error"], dict) else {}
                try:
                    code = float(err_obj.get("code"))
                except (TypeError, ValueError):
                    code = math.nan
                detail = bound_provider_text(str(err_obj.get("message") or json.dumps(data["error"])))
                if code == 429:
                    err = ModelInfraError("rate_limit", f"{model}: {detail}", status=429, model=model)
                    if _QUOTA_RE.search(detail):
                        return False, err, False
                    last_err = err
                else:
                    last_err = ModelInfraError(
                        "server_error",
                        f"{model}: provider error in 2xx body: {detail}",
                        status=int(code) if math.isfinite(code) else status,
                        model=model,
                    )
                backoff()
                continue
            self.last_model_used = model
            choices = data.get("choices") if isinstance(data, dict) else None
            msg = choices[0].get("message") if isinstance(choices, list) and choices and isinstance(choices[0], dict) else None
            if not isinstance(msg, dict):
                return True, {"type": "invalid", "reason": "empty_choices", "raw": _cap(json.dumps(data)), "model": model}, False
            prov: dict[str, Any] = {"model": model}
            preserved = self._capture_preserved(msg, data)
            if preserved:
                prov["provider_fields"] = preserved
            calls = msg.get("tool_calls") if isinstance(msg.get("tool_calls"), list) else []
            if len(calls) > 1:
                described = [
                    {
                        "name": id_map.get(str(((c or {}).get("function") or {}).get("name", "")), str(((c or {}).get("function") or {}).get("name", ""))),
                        "arguments": ((c or {}).get("function") or {}).get("arguments"),
                    }
                    for c in calls
                ]
                return True, {"type": "invalid", "reason": "multiple_tool_calls", "raw": _cap(json.dumps(described)), **prov}, False
            if len(calls) == 1:
                return True, self._to_tool_proposal(calls[0], id_map, prov), False
            if body.get("tool_choice") == "required" and not tried_auto_after_empty:
                tool_choice = "auto"
                tried_auto_after_empty = True
                continue
            content = msg.get("content")
            return True, {"type": "stop", "message": content if isinstance(content, str) else "", **prov}, False
        return False, last_err or ModelInfraError("server_error", f"no usable response from {model}", model=model), True

    @staticmethod
    def _wire(m: dict[str, Any], model: str) -> dict[str, Any]:
        out: dict[str, Any] = {"role": m["role"]}
        for k in ("content", "tool_call_id", "tool_calls"):
            if k in m:
                out[k] = m[k]
        if m["role"] == "assistant" and isinstance(m.get("provider_fields"), dict) and m.get("model") == model:
            for k, v in m["provider_fields"].items():
                if k not in out and k not in ("model", "provider_fields"):
                    out[k] = v
        return out

    def _classify_http(
        self, status: int, headers: dict[str, str], text: str, model: str
    ) -> tuple[ModelInfraError, bool, bool, float | None]:
        detail = f"{model} HTTP {status}: {bound_provider_text(text)}"
        if status == 429:
            err = ModelInfraError("rate_limit", detail, status=status, model=model)
            if _QUOTA_RE.search(text):
                return err, False, False, None
            return err, True, True, self._retry_after_ms(headers)
        if status in (401, 402, 403):
            if _QUOTA_OR_LIMIT_RE.search(text):
                return ModelInfraError("rate_limit", detail, status=status, model=model), False, False, None
            return ModelInfraError("auth", detail, status=status, model=model), False, False, None
        if status == 404:
            return ModelInfraError("model_unavailable", f"model unavailable: {detail}", status=status, model=model), False, True, None
        if status == 408:
            return ModelInfraError("timeout", detail, status=status, model=model), True, True, None
        if status >= 500:
            return ModelInfraError("server_error", detail, status=status, model=model), True, True, None
        if _QUOTA_OR_LIMIT_RE.search(text):
            return ModelInfraError("rate_limit", detail, status=status, model=model), False, False, None
        return ModelInfraError("bad_request", detail, status=status, model=model), False, True, None

    @staticmethod
    def _retry_after_ms(headers: dict[str, str]) -> float | None:
        h = headers.get("retry-after")
        if not h:
            return None
        try:
            secs = float(h)
            if math.isfinite(secs) and secs >= 0:
                return min(secs * 1000, MAX_RETRY_AFTER_MS)
        except ValueError:
            pass
        try:
            at = parsedate_to_datetime(h).timestamp() * 1000
        except (TypeError, ValueError):
            return None
        return min(max(0.0, at - time.time() * 1000), MAX_RETRY_AFTER_MS)

    def _capture_preserved(self, msg: dict[str, Any], data: dict[str, Any]) -> dict[str, Any] | None:
        out: dict[str, Any] | None = None
        for field in self.preserve_response_fields:
            v = msg.get(field) if msg.get(field) is not None else data.get(field)
            if v is None:
                continue
            out = out or {}
            out[field] = v
        return out

    def _to_tool_proposal(self, tc: Any, id_map: dict[str, str], prov: dict[str, Any]) -> dict[str, Any]:
        fn = (tc or {}).get("function") or {}
        transport_name = fn.get("name")
        name = id_map.get(transport_name) if isinstance(transport_name, str) else None
        if not name:
            return {"type": "invalid", "reason": "unknown_transport_tool", "raw": _cap(str(transport_name or "")), **prov}
        raw_args = fn.get("arguments")
        if raw_args is None or (isinstance(raw_args, str) and raw_args.strip() == ""):
            parsed: Any = {}
        elif isinstance(raw_args, str):
            try:
                parsed = json.loads(raw_args)
            except ValueError:
                return {"type": "invalid", "reason": "invalid_tool_arguments_json", "raw": _cap(raw_args), **prov}
        else:
            parsed = raw_args
        raw_text = raw_args if isinstance(raw_args, str) else json.dumps(raw_args)
        if not isinstance(parsed, dict):
            return {"type": "invalid", "reason": "tool_arguments_not_object", "raw": _cap(raw_text), **prov}
        if _has_non_canonical_number(parsed):
            return {"type": "invalid", "reason": "tool_arguments_non_canonical", "raw": _cap(raw_text), **prov}
        out: dict[str, Any] = {"type": "tool", "name": name, "args": parsed, "transport_name": transport_name, **prov}
        if isinstance(tc.get("id"), str) and tc["id"]:
            out["tool_call_id"] = tc["id"]
        return out


def create_adapter_from_deployment(
    deployment: dict[str, Any], *, post: HttpPost | None = None
) -> tuple[OpenAICompatibleAdapter, dict[str, Any]]:
    """TS ``createAdapterFromDeployment`` (openai-compatible + profiles, legacy transports)."""
    m = deployment.get("model") or {}
    transport = m.get("transport") or "openai-compatible"
    if transport == "recorded":
        raise ValueError("recorded transport is for fixtures only; use openai-compatible for live/run")
    legacy = {"openrouter": "openrouter", "ollama": "ollama"}.get(transport)
    profile = resolve_profile(m.get("profile") or legacy or "generic")
    if m.get("api_key"):
        raise ValueError("deployment.model.api_key is forbidden — use api_key_env")
    api_key_env = m.get("api_key_env") or profile["defaultApiKeyEnv"]
    api_key = resolve_api_key(api_key_env, profile.get("defaultApiKey"))
    base_url = m.get("base_url") or m.get("endpoint") or profile.get("defaultBaseUrl") or "https://api.openai.com/v1"
    models = m.get("models") or ([m["model"]] if m.get("model") else None) or profile.get("defaultModels") or []
    if not models:
        raise ValueError("deployment.model.models (or model) is required")
    models = filter_models_by_data_policy(list(models), deployment)
    banned = (profile.get("compatibility") or {}).get("prohibited_model_aliases") or []
    for mid in models:
        if mid in banned:
            raise ValueError(f"Model alias '{mid}' is prohibited for profile {profile['id']} (gateway system prompt)")
    timeout = m.get("timeout_ms")
    if timeout is not None and (not isinstance(timeout, int) or isinstance(timeout, bool) or timeout <= 0):
        raise ValueError("deployment.model.timeout_ms must be a positive integer (ms)")
    adapter = OpenAICompatibleAdapter(
        base_url=base_url,
        api_key=api_key,
        models=models,
        temperature=m.get("temperature"),
        max_tokens=m.get("max_tokens"),
        headers=dict(profile.get("defaultHeaders") or {}),
        capabilities=profile["capabilities"],
        preserve_response_fields=(m.get("compatibility") or {}).get("preserve_response_fields")
        or (profile.get("compatibility") or {}).get("preserve_response_fields"),
        timeout_ms=timeout,
        post=post,
    )
    return adapter, {"profile": profile["id"], "models": models, "base_url": base_url, "api_key_env": api_key_env}
