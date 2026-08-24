# Chess procedural reliability report

**Study:** `chess-procedural-wind-tunnel` · **Date:** 2026-08-04  
**Scope:** Track A fixtures + three harness variants (gated, permissive, oriented)

## Executive summary

| Gate criterion | Result |
|----------------|--------|
| Zero illegal **executed** moves (gated) | **PASS** — illegal proposals denied at verify; board never mutates |
| Stale-state proposals rejected | **PASS** — `position_hash` mismatch → `stale: 1` + verify deny |
| Deterministic replay | **PASS** — `chess-replay-determinism` golden log stable |
| Observe-before-move (gated/oriented) | **PASS** — sequence gate denies move without prior observe |
| Claim without evidence blocked (gated/oriented) | **PASS** — gate denies `game.claim` when `observed ≠ 1` |
| Terminal claim verified | **PASS** — checkmate claim after observe on terminal FEN |
| Permissive control measured separately | **PASS** — illegal proposals reach execute with `illegal: 1`; no board mutation |

**Bottom line:** Chess adapter proves procedural honesty. Strategic strength is **out of scope**.

## Conditions

| Harness | Sequences | Verify on move | Observe-before-claim |
|---------|-----------|----------------|----------------------|
| `legality-gated` | observe → move | illegal/stale deny | yes |
| `permissive-control` | none | none | no |
| `oriented` | observe → move + orientation | illegal/stale deny | yes |

## Track A fixture results

| Fixture | Illegal executed | Stale rejected | Notes |
|---------|------------------|----------------|-------|
| `chess-legal-move-ok` | 0 | — | e2e4 after observe |
| `chess-illegal-move-denied` | 0 | — | verify deny on e2e9 |
| `chess-stale-state-rejected` | 0 | yes | wrong position_hash |
| `chess-move-without-observe-denied` | 0 | — | sequence deny |
| `chess-claim-without-evidence-denied` | — | — | gate deny |
| `chess-terminal-claim-verified` | 0 | — | fool's mate FEN |
| `chess-replay-determinism` | 0 | — | e2e4 + e7e5 replay |
| `chess-permissive-illegal-allowed` | 0 | — | illegal output, no mutation |

Regenerate: `node --import tsx engines/ts/src/gen-chess-fixtures.ts` then `node --import tsx engines/ts/src/cli.ts replay`.

## Residuals / not claimed

- Live **procedural** series exists (see `SERIES-REPORT.md`); **strategic** evaluation (ACPL, Elo) is still out of scope until Phase 1 `chess:analyze`.
- No engine-bounded candidate selection variant.
- Python engine parity not implemented (TS-only adapter).
- Promotion moves and en passant rely on chess.js; not independently audited.
- Live series incomplete (16/20); infra and protocol aborts dominate — not gate failures.

## Next agent starts here

1. Read [`README.md`](README.md) and [`ADAPTER.md`](ADAPTER.md).
2. Run Track A: `node --import tsx engines/ts/src/cli.ts replay` (grep `chess-`).
3. Test harness: `node --import tsx engines/ts/src/cli.ts test case-studies/chess/harnesses/legality-gated`
4. Optional live: add `smoke.model.jsonl` / deployment.kit.yml and run `pnpm live` with `live/scenarios-chess/`.
5. Track S retry: only after chess gate accepted — see [`../swe-bench/results/FREEZE.md`](../swe-bench/results/FREEZE.md).

## Provenance

- Adapter: `engines/ts/src/adapters/chess.ts`
- Fixtures: `conformance/fixtures/chess-*`
- Harnesses: `case-studies/chess/harnesses/{legality-gated,permissive-control,oriented}/`
