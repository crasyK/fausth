# Fausth packaging and multi-host (status)

M4–M7 of the plan of record are **shipped**. This page is the operator map; normative rules stay in [`spec-v0.1.md`](spec-v0.1.md).

## M4 — Simulation and adapter compatibility

- [`engines/ts/src/adapters/simulation.ts`](../engines/ts/src/adapters/simulation.ts) — in-memory coding world
- Adapter failure (`binding_missing` / `adapter_unresolved`) ≠ harness authorize deny
- `fausth test <harness>` runs validate + bindings + smoke + related Track A fixtures

## M5 — Multi-host

Same [`examples/coding-counterbalance/`](../examples/coding-counterbalance/) harness on:

1. Local TypeScript (`fausth run`)
2. Python (`python -m fausth run`)
3. GitHub Actions ([`multi-host.yml`](../.github/workflows/multi-host.yml))

### M5.1 — Live models (Track B)

| Deployment | Env |
|---|---|
| `deployment.openrouter-free.yml` | `OPENROUTER_API_KEY` |
| `deployment.kit.yml` | `KIT_AI_API_KEY` |
| `deployment.openai.yml` | `OPENAI_API_KEY` (optional) |

Support-bot has the same OpenRouter/KIT pattern under [`examples/support-bot/`](../examples/support-bot/).

**Deferred (M5.2):** browser / WASM host; HTTP Python server; real FS/process adapter.

## M6 — Multi-agent

Nested reaction when spawn args include `proposals`. Child events use `depth` / `spawn_id`. Fixtures: `spawn-nested-ok`, `spawn-nested-deny`, `spawn-child-escalate-deny`.

## M7 — Packaging

```text
fausth validate <harness>
fausth test <harness> [--deployment <file>] [--skip-fixtures]
fausth inspect <harness>
fausth pack <harness> [--out <path|dir>]
fausth run <harness> --deployment <deployment>
```

```bash
pnpm ci:packaging
pnpm ci:multi-host
```

Share via git tags / release archives before any registry.
