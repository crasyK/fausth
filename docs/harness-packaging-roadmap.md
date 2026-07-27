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

**Deferred (M5.1):** browser / WASM host (security-permitting).

**Not yet:** HTTP Python server; real FS/process adapter (simulation stubs prove portability).

Same harness contract; only `deployment.yml` + bindings change across hosts once browser lands.

## M6 — Multi-agent

Tighten-only spawn already in v0.1. Expand only after M2–M3: nested reaction, no escalation, child log verification.

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
