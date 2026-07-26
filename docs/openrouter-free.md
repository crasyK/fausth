# OpenRouter free models (Track B)

Refresh date: **2026-07-27**

## Setup

1. Create an API key at [openrouter.ai/keys](https://openrouter.ai/keys) (no card required for free tier).
2. Copy `.env.example` → `.env` and set `OPENROUTER_API_KEY`.
3. Never commit `.env`.

## Pinned free models (fallback order)

1. `openai/gpt-oss-20b:free`
2. `meta-llama/llama-3.3-70b-instruct:free`
3. `openrouter/free` (auto-router — last resort)

If a pin returns 404 / unavailable, the adapter falls through and records which model served.

## Budget

| Limit | Typical free tier |
|-------|-------------------|
| Requests / minute | ~20 |
| Requests / day | ~50 (higher after credit purchase) |

Suite defaults: max 8 scenarios / run, 6 steps / scenario, 8 model calls / scenario, 429 retries ≤ 3.

## Running

```bash
pnpm live -- --scenarios live/scenarios \
  --report live/reports/out.json \
  --catch-rate-min 0.5
```

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | Pass |
| 1 | Infra / catch_rate failure |
| 2 | Rate limited or empty catalog — CI should **skip** (not fail the build) |

## Reading reports

JSON with per-scenario `model`, `steps`, `gate_denies`, `verify_failures`, `final_verdict`, and suite totals `catch_rate`, `verify_trigger_rate`, `judge_pass_rate`, `rate_limited`.

## Capture → promote

```bash
pnpm exec fausth capture --from live/reports/out.json --scenario gh-keep-safe-temp --out conformance/fixtures/candidate-gh-keep-safe-temp
```

Human reviews; only promote into Track A if outcomes are fully determined by gates/verify (no `judge`).
