# OpenRouter free models (Track B)

Refresh date: **2026-07-27**

Faust uses a single **OpenAI-compatible** transport with an `openrouter` provider profile.
See also [`openai-compatible.md`](openai-compatible.md) and the KIT institutional demo.

## Setup

1. Create an API key at [openrouter.ai/keys](https://openrouter.ai/keys).
2. Copy `.env.example` → `.env` and set `OPENROUTER_API_KEY` (never commit `.env`).
3. Deployment: [`examples/greenhouse/deployment.openrouter-free.yml`](../examples/greenhouse/deployment.openrouter-free.yml)

```yaml
model:
  transport: openai-compatible
  profile: openrouter
  api_key_env: OPENROUTER_API_KEY
  models:
    - cohere/north-mini-code:free
    - nvidia/nemotron-3-super-120b-a12b:free
    - google/gemma-4-26b-a4b-it:free
```

## Running

```bash
pnpm live
# or explicitly:
pnpm -C engines/ts exec node --import tsx src/cli.ts live \
  --deployment ../../examples/greenhouse/deployment.openrouter-free.yml \
  --scenarios ../../live/scenarios \
  --report ../../live/reports/out.json \
  --catch-rate-min 0.5
```

## Probe capabilities

```bash
pnpm -C engines/ts exec node --import tsx src/cli.ts provider probe \
  --deployment ../../examples/greenhouse/deployment.openrouter-free.yml \
  --report ../../live/reports/provider-probe.json
```

Exit codes for live: `0` pass · `1` catch_rate/infra fail · `2` rate limited (CI should skip).
