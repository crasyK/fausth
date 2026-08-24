# Fausth — start here

Portable **harness runtime**: the model proposes; Fausth decides what may run and how the world must prove it worked. This is the human map of the repo.

**Status:** `v0.3.0-alpha` · not production-safe.

Chess is **not** in this repo. The chess laboratory is `/home/mark/chess-harness` and depends on Fausth as `@fausth/engine-ts`.

## 30-second smoke

```bash
cd /home/mark/fausth
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
schema/         JSON Schema. Engines still validate contract v0.1;
                v0.2 is normative in docs; v0.3 is draft.
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
| CasaOS / Lab UI | Outside this repo (`/home/mark/fausth-lab`) |

## Specs

| File | Role |
|------|------|
| [`spec-v0.1.md`](spec-v0.1.md) | Baseline freeze (immutable goldens) |
| [`spec-v0.2.md`](spec-v0.2.md) | Current normative contract text |
| [`spec-v0.3-draft.md`](spec-v0.3-draft.md) | Candidates (output verifies, TTL, audit, budgets, mutable) |
| [`BASELINE-v0.1.md`](BASELINE-v0.1.md) | How the v0.1 pin is maintained |

Release narrative snapshots: [`archive/releases/`](archive/releases/).
