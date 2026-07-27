# Fausth v0.1 baseline

**Tag:** `v0.1.1-baseline`  
**Commit:** pinned at tag time on `main` / this branch tip when tagged.  
**Spec:** [`spec-v0.1.md`](spec-v0.1.md) · schema [`../schema/counterbalance-contract.v0.1.json`](../schema/counterbalance-contract.v0.1.json)

## What is frozen

- Canonical JSON IR rules and Track A golden logs under [`../conformance/fixtures/`](../conformance/fixtures/)
- Lifecycle kernel: `propose → validate → authorize → execute → verify`
- Verify kinds: `effect`, `evidence`, `absence` (no `judge` in goldens)
- TS ↔ Python byte-identical replay (`pnpm ci:conformance`)
- Tighten-only spawn lattice

## Immutability rule

v0.1 golden `expected.jsonl` files MUST NOT change unless [`spec-v0.1.md`](spec-v0.1.md) is deliberately corrected. Counterbalance v0.2 work adds **new** fixtures and optional fields; it must not silently rewrite v0.1 expectations.

## Reference harness (not the product boundary)

[`../examples/slopathon-review/`](../examples/slopathon-review/) and [`ci-quality-gate.md`](ci-quality-gate.md) demonstrate Fausth hosted in GitHub Actions as a **CI quality gate**. That is a product surface and portability proof. Fausth itself is the portable harness / Counterbalance runtime — see [`counterbalance-architecture.md`](counterbalance-architecture.md).
