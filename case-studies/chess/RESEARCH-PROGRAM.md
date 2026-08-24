# Chess as the Counterbalance laboratory

**Status:** substrate (H0–H2 + 641-ply corpus) is in-repo. Phases 1–3 (the ruler) are **not built**. H3–H6 are documented follow-ons.

This is the in-repo copy of the research program. Episode assets: [`series/`](series/).

## Thesis

Holding model weights, sampling, opponent distribution, and compute budget fixed, Counterbalance-guided harness interventions improve legality, tactical awareness, strategic continuity, move quality, and game outcomes — **without** runtime engine move recommendations.

## Already in the tree (do not rebuild)

| Piece | Path |
|-------|------|
| Board truth | `engines/ts/src/adapters/chess.ts` |
| H0 / H1 / H2 | `harnesses/{permissive-control,legality-gated,oriented}/` |
| Two-model orchestrator | `engines/ts/src/chess-match.ts` · `pnpm chess:match` |
| Track A goldens | `conformance/fixtures/chess-*` · `pnpm chess:fixtures` |
| Live corpus | `live/reports/chess-series/traces/game-NN.jsonl` (gitignored; 641 plies) |
| Memory / instincts cells | Framework support in `engines/ts/src/types.ts` — **not wired to chess yet** |

## Harness ladder

| Id | Condition | In-repo? |
|----|-----------|----------|
| H0 | Permissive control (no sequence gates) | Yes |
| H1 | Legality-gated (observe → move, illegal/stale deny) | Yes — live series |
| H2 | Oriented (H1 + orientation emit) | Yes — not used in live series |
| H3 | Tactics tool (`board.tactics` / richer observe) — chess.js only, no engine | No |
| H4 | Typed memory (plan, threats, commitments) + provenance/TTL | No |
| H5 | Instincts (style policies) with gate counterweights | No |
| H6 | Composition + skills-only self-patch on frozen/holdout positions | No |

## Phase 1 — measurement instrument (next)

Build the ruler **before** changing harnesses.

1. `engines/ts/src/engine/uci.ts` — UCI client. Default: pinned Stockfish WASM. Optional: `FAUSTH_STOCKFISH_PATH`.
2. `engines/ts/src/engine/classify.ts` — Win%/centipawn → best/good/inaccuracy/mistake/blunder + ACPL.
3. `engines/ts/src/chess-analyze.ts` + `pnpm chess:analyze` — score existing traces offline. **Zero new inference.**
4. Engine stays orchestrator-side. Never wire it into `createChessTools()`.

Success: the 641-ply series is fully scored (ACPL, blunder rate, best-move rate) with provenance (engine version, depth).

GitHub: [#50](https://github.com/crasyK/fausth/issues/50).

## Phase 2 — Track P (position suite)

- `case-studies/chess/positions/suite.yml` — FEN, category, expected property, `split: frozen|holdout`
- `engines/ts/src/chess-suite.ts` — fixed model × H0/H1/H2, equal budgets
- Output: `live/reports/chess-suite/`

## Phase 3 — Track G (opponent ladder)

- Extend `chess-match.ts`: `--opponent random|stockfish:elo-N|llm:<deployment>`
- Funnel: suite → random → weak engine → Elo ladder
- Output: `live/reports/chess-ladder/`

## Protocol constants (every run)

- Pin model + deployment (`deployments/kit.yml`: temperature 0, max_tokens 1024)
- Record: harness id, model, sampling, engine version/depth, tokens/latency/cost
- Report **equal-budget** and **best-achievable**; efficiency = quality gain / extra tokens

## Later (do not start until Phase 1 lands)

- **H3:** read-only tactics from chess.js (attack maps, hanging pieces). Ablate H2 vs H3.
- **H4:** `memory_notes` + typed plan; score **claim fidelity**, not assumed faithfulness.
- **H5:** `instinct_text` with forced-defense / large-eval-swing reassessment. Never Stockfish-preference gates.
- **H6:** compose axes; skills-only patches on frozen positions, confirm on holdout.

## YouTube / series layer

Research chapters **are** the episode spine. Format and slate: [`series/README.md`](series/README.md).

## Traps

- Host Node is often v20; repo requires **>=22**.
- WASM Stockfish ≠ native at shallow depth — pin version + depth on every artifact.
- Puzzle licenses for Track P go in [`results/PROVENANCE.md`](results/PROVENANCE.md).
- `UCI_Elo` is approximate — always report Stockfish version next to Elo estimates.
