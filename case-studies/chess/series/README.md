# Chess harness engineering series (episodes)

Devlog about **harness engineering**. Game footage is real traces — nothing staged. Science artifacts and episode notes must not diverge: pull numbers from the same `live/reports/` and `results/` files.

## Episode format

1. **Cold open** — one artifact (denied illegal, blunder, surprising metric).
2. **Question** — one falsifiable claim.
3. **Build** — the YAML/tool diff, not slides.
4. **Run** — board + model’s visible structured analysis.
5. **Verdict** — metric table vs the previous condition, including where the hypothesis failed.
6. **Hook** — what the failure implies for the next episode.

Per-episode folder (create when the chapter runs): `ep-NN/` with notes, trace excerpts, metric table, selected games.

## Slate (not committed until Phase 1)

| Ep | Working title | Depends on |
|----|---------------|------------|
| 0 | The board refuses to lie — Stockfish on the 641-ply corpus, zero new inference | Phase 1 `chess:analyze` |
| 1 | Can it even see the board? — position suite H0/H1/H2 | Phase 2 |
| 2 | Give it eyes — H3 tactics | Phase 4 |
| 3 | A plan it can revise — H4 memory | Phase 5 |
| 4 | Personality, then constrain it — H5 instincts | Phase 6 |
| 5 | Full harness, or too much scaffolding? — H6 | Phase 7 |
| 6 | The harness improves itself — skills-only patches, frozen vs holdout | Phase 7 |

Interstitials: single-ply walkthroughs, illegal-move denials, Elo-per-dollar explainers.

## Production tooling

Traces, JSON metrics, and ASCII `run.log` are the source of truth. In-repo animated replay is **parked** until the format is chosen.
