# OpenAI-compatible transport (primary)

Faust’s primary model integration is **one OpenAI-compatible Chat Completions transport** plus small **provider profiles**. The runtime never talks to OpenRouter, KIT, Ollama, or vLLM directly — only to `ModelPort.propose`.

```text
canonical ModelPort request
        ↓
provider profile (defaults + quirks)
        ↓
OpenAI-compatible HTTP /chat/completions
        ↓
normalized Faust proposal (tool | stop | invalid)
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
    - azure.gpt-4.1-mini
```

Legacy `transport: openrouter` / `transport: ollama` still resolve to the matching profile.

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

## Data policy (optional)

Admin-authored `model_catalog` entries can declare residency / personal_data policy. Optional `data_policy.require.residency` filters the model list before any request. Model **names** are never used as policy.

## Provider probe

```bash
fausth provider probe --deployment examples/greenhouse/deployment.kit.yml
```

Probes auth, basic chat, and native tool calling without sensitive payloads. Writes a redacted capability report.

## Examples

- OpenRouter: `examples/greenhouse/deployment.openrouter-free.yml`
- Ollama: `examples/greenhouse/deployment.ollama.yml`
- KIT: `examples/greenhouse/deployment.kit.yml` (requires institutional credentials; live tests optional)
