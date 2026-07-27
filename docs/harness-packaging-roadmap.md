# Harness packaging and multi-host portability (M4–M7 roadmap)

These capabilities wait until the single-agent Counterbalance loop is proven (coding + support fixtures green).

## M4 — Simulation and adapter compatibility

- [`engines/ts/src/adapters/simulation.ts`](../engines/ts/src/adapters/simulation.ts) — in-memory coding world (no real FS/process).
- Distinguish **adapter failure** (binding missing) from **harness failure** (gate/sequence deny).
- Command goal: `fausth test <harness>` runs entirely from fixtures + simulation.

## M5 — Multi-host

**Exit (this milestone):** the same [`examples/coding-counterbalance/`](../examples/coding-counterbalance/) harness runs on:

1. Local TypeScript (`fausth run … --deployment …`)
2. Python process host (`python -m fausth run …`)
3. GitHub Actions ([`.github/workflows/multi-host.yml`](../.github/workflows/multi-host.yml) via `scripts/multi-host-smoke.mjs`)

Only `deployment.yml` + bindings change; `agent.yml` is shared. Bindings are enforced: missing/unknown natives are **adapter failures**, distinct from harness deny.

### M5.1 — Live models (Track B)

Same coding-counterbalance harness against real model transports (TS host). Swap only the deployment:

| Deployment | Env |
|---|---|
| [`deployment.openrouter-free.yml`](../examples/coding-counterbalance/deployment.openrouter-free.yml) | `OPENROUTER_API_KEY` |
| [`deployment.kit.yml`](../examples/coding-counterbalance/deployment.kit.yml) | `KIT_AI_API_KEY` |
| [`deployment.openai.yml`](../examples/coding-counterbalance/deployment.openai.yml) | `OPENAI_API_KEY` |

- Scenarios: [`live/scenarios-coding-counterbalance/`](../live/scenarios-coding-counterbalance/)
- CI: [`.github/workflows/live-openrouter.yml`](../.github/workflows/live-openrouter.yml) (each provider skipped when its secret is absent)

Python live transport remains out of scope (recorded `fausth-py run` only).

**Deferred (M5.2):** browser / WASM host (security-permitting).

**Not yet:** HTTP Python server; real FS/process adapter (simulation stubs prove portability for Track A).

## M6 — Multi-agent

Tighten-only spawn (v0.1) now **runs a nested reaction** when spawn args include recorded `proposals`:

- Child IR is tighten-only (tools / FS / limits); `spawn.allow` only if parent `allow_nested`
- Child events are appended to the parent log with `depth` + `spawn_id`
- Track A fixtures: `spawn-nested-ok`, `spawn-nested-deny`, `spawn-child-escalate-deny`

Stub-only spawn (no `proposals`) keeps existing `spawn-ok` goldens unchanged.

## M7 — Packaging

Proposed commands (not implemented yet):

```text
fausth validate <harness>
fausth test <harness>
fausth inspect <harness>
fausth pack <harness>
fausth run <harness> --deployment <deployment>
```

Share via git tags / release archives before any registry.
