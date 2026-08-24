# Fausth — start here

Portable **harness runtime**: the model proposes; Fausth decides what may run and how the world must prove it worked. This is the human map of the repo.

**Status:** `v0.3.0-alpha` · not production-safe · chess is the active research world.

## 30-second smoke

```bash
cd /home/mark/fausth
corepack enable && pnpm install
pnpm -C engines/ts test          # unit tests
pnpm chess:fixtures && pnpm replay
# grep the replay output for chess-* — those eight should PASS
```

Node **22+** is required (`package.json` `engines.node`). Track A chess does not need API keys. Live KIT matches need `KIT_AI_API_KEY`.

## What to read (in order)

| If you want… | Open |
|--------------|------|
| Product claim + CLI | [`README.md`](../README.md) |
| Author a harness | [`authoring.md`](authoring.md) then [`HOW-TO.md`](HOW-TO.md) |
| How the runtime is shaped | [`architecture.md`](architecture.md) · [`counterbalance-architecture.md`](counterbalance-architecture.md) |
| Terms | [`glossary.md`](glossary.md) |
| Chess research (north star) | [`../case-studies/chess/README.md`](../case-studies/chess/README.md) · [`../case-studies/chess/RESEARCH-PROGRAM.md`](../case-studies/chess/RESEARCH-PROGRAM.md) |
| Case-study method | [`case-studies/PROTOCOL.md`](case-studies/PROTOCOL.md) · [`case-studies/README.md`](case-studies/README.md) |
| Evidence pack (`claim.yml`) | [`evidence-pack.md`](evidence-pack.md) |
| Known bugs | [`KNOWN-ISSUES.md`](KNOWN-ISSUES.md) · [GitHub issues](https://github.com/crasyK/fausth/issues) |

## Repo map

```
engines/ts/     TypeScript runtime (primary). CLI: pnpm fausth -- help
engines/py/     Python replay/pack parity. No chess adapter yet.
schema/         JSON Schema. Engines still validate contract v0.1;
                v0.2 is normative in docs; v0.3 is draft.
conformance/    Track A golden event logs (immutable except via generators)
case-studies/   Bounded empirical studies. Chess is live; SWE/τ/adversarial frozen.
examples/       Runnable harness library (CI smoke). See examples/README.md
worlds/         Catalog stubs pointing at harnesses + case-study manifests
live/scenarios* Live-model scenario YAML
live/reports/   Gitignored raw runs. Chess series: live/reports/chess-series/
docs/archive/   Old release notes and deferred recon
```

## Two tracks (do not mix)

| Track | Meaning | Chess today |
|-------|---------|-------------|
| **A — recorded** | Byte-identical event logs. No live model. | 8 `chess-*` fixtures, all PASS on TS |
| **B — live** | Real models, never written into goldens | 16/20 KIT games, 641 legal plies, gates held |

Claims that mix the two without saying so are invalid. See [`evidence-pack.md`](evidence-pack.md).

## Chess in one paragraph

The board is owned by `chess.js`. Models only propose UCI. Three harnesses already exist: **H0** permissive-control, **H1** legality-gated (used for the live series), **H2** oriented. Measurement (Stockfish / position suite / opponent ladder) is **not built** — that is Phase 1–3 of the [research program](../case-studies/chess/RESEARCH-PROGRAM.md). Do not optimize for Elo until the ruler exists.

## What is frozen vs live

| Study | Status |
|-------|--------|
| Chess | **Live north star** — Track A gate passed; live series partial |
| Coding Counterbalance | Published HRI Track C pilot |
| SWE-bench Lite | **Frozen** negative (`case-studies/swe-bench/results/FREEZE.md`) |
| τ-bench, adversarial | Frozen HRI pins |
| Mutable cells, harness-optimize | Scaffold / stub — not the next chess chapter |
| Kaggriculture | Deferred — [`archive/recon/kaggriculture.md`](archive/recon/kaggriculture.md) |
| CasaOS / Lab UI | Outside this repo (`/home/mark/fausth-lab`, CasaOS apps on the homeserver) |

## Specs

| File | Role |
|------|------|
| [`spec-v0.1.md`](spec-v0.1.md) | Baseline freeze (immutable goldens) |
| [`spec-v0.2.md`](spec-v0.2.md) | Current normative contract text |
| [`spec-v0.3-draft.md`](spec-v0.3-draft.md) | Candidates (output verifies, TTL, audit, budgets, mutable) |
| [`BASELINE-v0.1.md`](BASELINE-v0.1.md) | How the v0.1 pin is maintained |

Release narrative snapshots: [`archive/releases/`](archive/releases/).
