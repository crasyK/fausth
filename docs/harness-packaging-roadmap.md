# Harness packaging and multi-host portability (M4–M7 roadmap)

These capabilities wait until the single-agent Counterbalance loop is proven (coding + support fixtures green).

## M4 — Simulation and adapter compatibility

- [`engines/ts/src/adapters/simulation.ts`](../engines/ts/src/adapters/simulation.ts) — in-memory coding world (no real FS/process).
- Distinguish **adapter failure** (binding missing) from **harness failure** (gate/sequence deny).
- Command goal: `fausth test <harness>` runs entirely from fixtures + simulation.

## M5 — Multi-host

Same harness contract; only `deployment.yml` + bindings change:

1. Local TypeScript  
2. GitHub Actions (SLOPATHON reference)  
3. Python server  
4. Browser (security-permitting)

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
