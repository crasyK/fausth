# OpenAI-compatible transport (primary)

Faust’s primary model integration is **one OpenAI-compatible Chat Completions transport** plus small **provider profiles**. The runtime never talks to OpenRouter, KIT, Ollama, or vLLM directly — only to `ModelPort.propose`.

```text
canonical ModelPort request
        ↓
provider profile (defaults + quirks)
        ↓
OpenAI-compatible HTTP /chat/completions
        ↓
normalized Faust proposal (tool | stop | invalid)   — or a thrown ModelInfraError
        ↓
Counterbalance runtime validates / authorizes
```

## Deployment shape

```yaml
model:
  transport: openai-compatible
  profile: kit-scc   # or openrouter | ollama | generic
  base_url: https://ki-toolbox.scc.kit.edu/api/v1
  api_key_env: KIT_AI_API_KEY   # never put the secret in YAML
  models:
    - kit.glm-5.3-flash          # default (first); later entries are infra fallbacks only
    - kit.deepseek-v4-flash
  timeout_ms: 120000             # optional; per request incl. body read (default 120000)
```

Legacy `transport: openrouter` / `transport: ollama` still resolve to the matching profile.

`model.compatibility.preserve_response_fields` in the deployment overrides the profile's list.

## Profiles

| Profile | Default base URL | Key env |
|---------|------------------|---------|
| `generic` | (required in deployment) | `OPENAI_API_KEY` |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `ollama` | `http://127.0.0.1:11434/v1` | `OLLAMA_API_KEY` (default `ollama`) |
| `kit-scc` | `https://ki-toolbox.scc.kit.edu/api/v1` | `KIT_AI_API_KEY` |

Profiles declare capabilities and compatibility quirks (`preserve_response_fields`, prohibited gateway aliases such as KIT `standard-external` / `standard-local`).

## Tool schemas and transport names

- Faust sends each tool’s real `input` JSON Schema as OpenAI `function.parameters`.
- Transport function names are opaque (`faust_tool_0001`, …) with an exact request-local map back to canonical IDs — no underscore↔dot heuristics.
- Runtime validation of returned args remains authoritative (independent of what the model saw).

## One tool per step

The runtime executes exactly one tool per step, so the transport never drops calls silently:

- Requests that offer tools carry `parallel_tool_calls: false` (unless the profile sets
  `capabilities.parallel_tool_calls_param: false`). If an endpoint rejects the flag with a 4xx
  naming `parallel_tool_calls`, the request is resent once without it and the adapter
  remembers that for the model.
- A response with more than one `tool_calls` entry becomes
  `{ type: "invalid", reason: "multiple_tool_calls", raw: [{name, arguments}, …] }` (canonical
  tool ids, bounded to 1000 code points). The conversational layer records that turn as plain
  assistant text (never as `tool_calls`, so no tool-call id is left unanswered), nudges
  "call exactly one tool", and retries once; a second failure keeps its real reason.

Tool `arguments` must decode to a JSON **object**: an empty string means `{}`; `null`, arrays
and scalars are `tool_arguments_not_object`; non-integral or non-int53 numbers are
`tool_arguments_non_canonical` (D3 — rejected where they enter, never at the end of a run).

## Errors: infra vs model protocol

Experiments must be able to exclude infrastructure failures from model scores, so the two
classes never mix:

| Class | Surface | Values |
|-------|---------|--------|
| Infra (no model answer) | thrown `ModelInfraError` (`isModelInfraError(e)`), fields `kind`, `status?`, `model?` | `timeout`, `rate_limit`, `server_error`, `network`, `auth`, `bad_request`, `model_unavailable` |
| Model protocol (answer unusable) | returned `{ type: "invalid", reason }` | `empty_choices`, `unknown_transport_tool`, `invalid_tool_arguments_json`, `tool_arguments_not_object`, `tool_arguments_non_canonical`, `multiple_tool_calls`, `empty_proposal` (closed set `MODEL_PROTOCOL_INVALID_REASONS`) |

Retry / fallback policy per request (models are tried in deployment order):

| Response | Kind | Same-model retry | Next model |
|----------|------|------------------|------------|
| timeout (AbortSignal), network error, HTTP 408 | `timeout` / `network` | yes (backoff) | yes |
| HTTP 429 | `rate_limit` | yes (honours `Retry-After`, capped 60 s) | yes |
| HTTP 429 / 4xx mentioning a daily / per-day quota | `rate_limit` | no | **no** (stop) |
| HTTP 5xx, non-JSON 2xx body, provider error inside a 2xx body | `server_error` | yes | yes |
| HTTP 401 / 402 / 403 | `auth` | no | **no** (stop) |
| HTTP 404 | `model_unavailable` | no | yes |
| other 4xx | `bad_request` | no | yes |

Backward compatibility: rate-limit errors keep the `RATE_LIMIT:` message prefix and
`code === 2`. Provider text in error messages is bounded (500 code points) and key-like
tokens are redacted. The proposal reports the model that answered (`proposal.model`,
`adapter.lastModelUsed`) — check it when a deployment lists fallbacks.

Timeouts: `deployment.model.timeout_ms` (default 120000) bounds connect **and** body read
of every request, via an `AbortController` whose timer is cleared when the body is read.

## Preserved provider fields (reasoning)

Fields listed in `preserve_response_fields` (e.g. `reasoning_details`) are captured from the
response **message** and returned on the proposal as `provider_fields` together with `model`.
The conversational layer stores them on the assistant turn they came from; on the wire the
transport re-attaches them to **that assistant message**, and only when the next request goes
to the **same model**. They are never sent at the request root, and never shared between
conversations that reuse one adapter.

## Data policy (optional)

Admin-authored `model_catalog` entries can declare residency / personal_data policy. Optional `data_policy.require.residency` filters the model list before any request. Model **names** are never used as policy.

The filter **fails closed**: a residency requirement with a missing or empty `model_catalog`
is a configuration error (no catalog, no model), and models not listed in the catalog with the
required residency are removed; if none remain, adapter creation fails.

## Provider probe

```bash
fausth provider probe --deployment examples/greenhouse/deployment.kit.yml
```

Probes auth, basic chat, and native tool calling without sensitive payloads. Writes a redacted capability report.
Failures carry `error_kind` (an infra kind or `config`); an outage during the tool probe leaves
`native_tools: "unknown"` with `tool_probe_error` instead of claiming tools are unsupported.

## KIT gateway notes (live smoke, 2026-10-13)

Current KIT-hosted local models (D15): `kit.glm-5.3-flash` (default) and `kit.deepseek-v4-flash`;
older `kit.*` ids (minimax, mistral, qwen, gemma) are retired.

Observed through `OpenAICompatibleAdapter` (7 requests in total):

- `kit.glm-5.3-flash`: native tool call round-trip works (tool call → tool result → `stop`);
  `tool_choice: "required"` and `parallel_tool_calls: false` are accepted. Response messages carry
  `role`, `content`, `tool_calls` and `provider_specific_fields` (LiteLLM-style proxy); no
  `reasoning_details` was returned, so nothing was preserved.
- `kit.deepseek-v4-flash`: native tool call works; `parallel_tool_calls: false` accepted.
- Response caching is **per model and not something to rely on**. Another session observed that
  the gateway caches `kit.glm-5.3-flash` by request body (byte-identical responses including the
  tool-call id, even at temperature 0.7), and that `kit.deepseek-v4-flash` is not cached and not
  fully deterministic at temperature 0. In this smoke, two identical sequential temperature-0
  requests to `kit.glm-5.3-flash` were **not** byte-identical (different response and tool-call
  ids, same 785-byte length), so caching is intermittent. Consequences: repeated identical
  requests are not independent samples (check response ids before counting repetitions), and
  temperature 0 is not a determinism guarantee — Track A recordings remain the replay source.
- One request hit the 60 s client timeout during a latency spike — the reason every request is
  bounded and classified as `timeout` infra rather than a model failure.

## Examples

- OpenRouter: `examples/greenhouse/deployment.openrouter-free.yml`
- Ollama: `examples/greenhouse/deployment.ollama.yml`
- KIT: `examples/greenhouse/deployment.kit.yml` (requires institutional credentials; live tests optional)
