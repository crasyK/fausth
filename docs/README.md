# Fausth — start here

Portable **harness runtime**: the model proposes; Fausth decides what may run and how the world must prove it worked. This is the human map of the repo.

**Status:** `v0.3.0-alpha` · not production-safe.

Chess is **not** in this repo. The chess laboratory is `/home/mark/research/chess-harness` and depends on Fausth as an editable Python package (`../fausth/engines/py`).

## 30-second smoke

```bash
cd /home/mark/research/fausth
corepack enable && pnpm install
pnpm -C engines/ts test
pnpm fausth -- test examples/coding-counterbalance
```

Node **22+** is required (`package.json` `engines.node`).

## What to read (in order)

| If you want… | Open |
|--------------|------|
| Product claim + CLI | [`README.md`](../README.md) |
| Author a harness | [`authoring.md`](authoring.md) then [`HOW-TO.md`](HOW-TO.md) |
| How the runtime is shaped | [`architecture.md`](architecture.md) · [`counterbalance-architecture.md`](counterbalance-architecture.md) |
| Terms | [`glossary.md`](glossary.md) |
| Case-study method | [`case-studies/PROTOCOL.md`](case-studies/PROTOCOL.md) · [`case-studies/README.md`](case-studies/README.md) |
| Evidence pack (`claim.yml`) | [`evidence-pack.md`](evidence-pack.md) |
| Known bugs | [`KNOWN-ISSUES.md`](KNOWN-ISSUES.md) · [GitHub issues](https://github.com/crasyK/fausth/issues) |

## Repo map

```
engines/ts/     TypeScript runtime (primary). CLI: pnpm fausth -- help
engines/py/     Python replay/pack parity
schema/         JSON Schema. counterbalance-contract.v0.1.json is the one executable IR
                schema (spec ids v0.1–v0.3); the v0.2 agent/world/exchange schema is a
                non-loadable draft. Normative text: docs/spec-v0.3.md.
conformance/    Track A golden event logs (immutable except via generators)
case-studies/   Bounded empirical studies (coding, SWE, τ, adversarial)
examples/       Runnable harness library (CI smoke). See examples/README.md
worlds/         Catalog stubs pointing at harnesses + case-study manifests
live/scenarios* Live-model scenario YAML
live/reports/   Gitignored raw runs
docs/archive/   Old release notes and deferred recon
```

## Two tracks (do not mix)

| Track | Meaning |
|-------|---------|
| **A — recorded** | Byte-identical event logs. No live model. |
| **B — live** | Real models, never written into goldens |

Claims that mix the two without saying so are invalid. See [`evidence-pack.md`](evidence-pack.md).

## What is frozen vs live

| Study | Status |
|-------|--------|
| Coding Counterbalance | Published HRI Track C pilot |
| SWE-bench Lite | **Frozen** negative (`case-studies/swe-bench/results/FREEZE.md`) |
| τ-bench, adversarial | Frozen HRI pins |
| Mutable cells, harness-optimize | Scaffold / stub |
| Kaggriculture | Deferred — [`archive/recon/kaggriculture.md`](archive/recon/kaggriculture.md) |
| CasaOS / Lab UI | Outside this repo (`/home/mark/fausth-lab`, removed 2026-10-11) |

## Specs

| File | Role |
|------|------|
| [`spec-v0.3.md`](spec-v0.3.md) | **Normative** executable contract (overrides v0.1/v0.2 on conflict); goldens derive from it |
| [`spec-v0.2.md`](spec-v0.2.md) | Counterbalance bridge history; §1 authoring shape is a non-loadable draft |
| [`spec-v0.1.md`](spec-v0.1.md) | Baseline (where not overridden) |
| [`spec-v0.3-draft.md`](spec-v0.3-draft.md) | Open candidates only (authoring-shape translation, host_day budgets) |
| [`BASELINE-v0.1.md`](BASELINE-v0.1.md) | How the v0.1 pin is maintained |

Release narrative snapshots: [`archive/releases/`](archive/releases/).
