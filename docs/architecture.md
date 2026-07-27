# Architecture

```
agent.yml + deployment.yml
        ↓
  Canonical JSON IR  (schema-validated)
        ↓
  ┌─────┴─────┐
  engines/ts   engines/py
        ↓
  ModelPort ← openai-compatible transport + provider profiles
        ↓
  Native tool registry → world
```

## Lifecycle (v0.1 shipped)

`propose → validate → authorize → execute → verify`

Named stubs: `observe`, `record`, `rebalance`.

Verdicts: `allow` | `deny` | `safe_state`.

## Model transport

One primary **OpenAI-compatible** adapter. Profiles (`openrouter`, `ollama`, `kit-scc`, `generic`) supply base URL, key env, headers, and capability quirks. Secrets via `api_key_env` only. Details: [`openai-compatible.md`](openai-compatible.md).

## Two tracks

- **Track A:** golden-log replay (`recorded` adapter) — byte-identical across TS/Py.
- **Track B:** live suites via deployment profiles (OpenRouter public demo; KIT institutional optional) — never mutates Track A expectations automatically.

Normative semantics: [`spec-v0.1.md`](spec-v0.1.md).  
Philosophy (Counterbalance Architecture): Notion *My Harness Engineering Journey*.
