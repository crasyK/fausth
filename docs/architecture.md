# Architecture

Fausth is a **portable runtime and standard for agent harnesses**: one reaction vessel with two programmable sides and an externally constrained model in the middle.

```text
┌────────────────────────── FAUSTH HARNESS ──────────────────────────┐
│   AGENT                         WORLD                               │
│   Skills / Memory / Instincts ↔ Gates / User / Permissions+hooks   │
└───────────────────────────────┬────────────────────────────────────┘
                                │
                     Environment / world adapter
                                │
              local · CI · Python · simulation
                                │
                    (browser deferred — M5.2)
```

Glossary: [`glossary.md`](glossary.md).  
Counterbalance thesis: [`counterbalance-architecture.md`](counterbalance-architecture.md).  
Normative v0.1: [`spec-v0.1.md`](spec-v0.1.md).  
v0.1 baseline freeze: [`BASELINE-v0.1.md`](BASELINE-v0.1.md).

## Artifacts

| Artifact | Role |
|----------|------|
| Harness (`agent.yml` today) | Portable reaction semantics (agent + world policy) |
| `deployment.yml` | Model transport + native bindings (not portable policy) |
| Canonical JSON IR | Schema-validated runtime form |

```
harness + deployment
        ↓
  Canonical JSON IR
        ↓
  engines/ts · engines/py
        ↓
  ModelPort (openai-compatible + profiles)   ← deployment concern
        ↓
  Native tool registry / world adapter
```

`deployment.bindings` are **enforced** at resolve time ([`engines/ts/src/adapters/registry.ts`](../engines/ts/src/adapters/registry.ts)). Missing or unknown `native` ids fail as **adapter errors** (`binding_missing` / `adapter_unresolved`) before the exchange loop — they are not harness `authorize` denies.

Multi-host smoke (same coding-counterbalance harness on TS + Python + GHA): [`harness-packaging-roadmap.md`](harness-packaging-roadmap.md) §M5 · `pnpm ci:multi-host`.

## Lifecycle (v0.1 shipped)

`propose → validate → authorize → execute → verify`

Named stubs: `observe`, `record`, `rebalance`.  
Verdicts: `allow` | `deny` | `safe_state`.

v0.2 extends this kernel with explicit observe/orient/complete and memory invalidation — see the Counterbalance draft. New semantics land only behind Track A fixtures.

## Two tracks

- **Track A:** golden-log replay (`recorded`) — byte-identical TS/Py.
- **Track B:** live suites via deployment profiles — never mutates Track A automatically.

## Reference surfaces

- Coding / greenhouse examples — local harness demos.
- [`examples/slopathon-review/`](../examples/slopathon-review/) — CI host case study (GitHub Actions), **not** the product boundary.
