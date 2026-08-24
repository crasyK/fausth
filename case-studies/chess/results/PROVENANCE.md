# Chess provenance

**Gate passed:** 2026-08-04 (Track A fixtures)  
**Live series:** 2026-08-04 ≈14:27–19:06 UTC · 16/20 games · `live/reports/chess-series/`

## Adapter

- `engines/ts/src/adapters/chess.ts`
- Dependency: `chess.js@1.0.0-beta.8` in `engines/ts/package.json`

## Fixtures (regenerate)

```bash
pnpm chess:fixtures
# or: node --import tsx engines/ts/src/gen-chess-fixtures.ts
```

## Harness dirs

- `case-studies/chess/harnesses/legality-gated/` (H1 — live series)
- `case-studies/chess/harnesses/permissive-control/` (H0)
- `case-studies/chess/harnesses/oriented/` (H2)

## Live artifacts (gitignored)

| Path | Role |
|------|------|
| `live/reports/chess-series/summary.json` | Series totals |
| `live/reports/chess-series/traces/game-NN.jsonl` | Per-ply traces (641 legal plies) |
| `live/reports/chess-series/games/game-NN.json` | Per-game reports |
| `live/reports/chess-series/run.log` | ASCII board stream |
| `live/reports/chess-series/games/game-17.partial.json` | Orphan checkpoint (series stopped) |

Regenerate a series: `pnpm chess:match` (requires `KIT_AI_API_KEY`). Do not commit traces.

Early smoke and rotated logs were moved to gitignored `live/archive/chess/`.

## Reports (committed)

- `PROCEDURAL-RELIABILITY.md` — Track A
- `SERIES-REPORT.md` — Track B
- `claim.yml` · `residuals.json`

## Independence

Board truth is chess.js. Live traces must never be copied into `conformance/fixtures/`.
