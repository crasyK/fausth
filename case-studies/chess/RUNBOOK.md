# Chess runbook

## Prerequisites

- Node **22+** (`package.json` `engines.node`). A v20 host will warn and may break later tooling.
- `pnpm install` at repo root
- Live KIT runs: `KIT_AI_API_KEY`
- `chess.js` in `engines/ts` dependencies (installed with engine)

See also: [`README.md`](README.md) · [`RESEARCH-PROGRAM.md`](RESEARCH-PROGRAM.md) · [`../../docs/KNOWN-ISSUES.md`](../../docs/KNOWN-ISSUES.md)

## Regenerate Track A fixtures

After changing adapter, harness gates, or runtime:

```bash
node --import tsx engines/ts/src/gen-chess-fixtures.ts
node --import tsx engines/ts/src/cli.ts replay 2>&1 | grep chess
```

All eight `chess-*` fixtures should show `PASS`.

## Validate harnesses

```bash
for h in legality-gated permissive-control oriented; do
  node --import tsx engines/ts/src/cli.ts test "case-studies/chess/harnesses/$h"
done
```

## Known traps

1. **Fixture agent FEN:** `chess-terminal-claim-verified` embeds fool's mate FEN in `agent.json` — do not reset to start position when regenerating.
2. **Sequence field names:** use `action` + `require_prior_tools`, not `before` + `require_prior`.
3. **position_hash:** moves should include hash from latest `board.observe` in gated/oriented conditions.
4. **Replay uses `buildTools`:** chess tools activate when agent lists `board.observe` / `board.move` / `game.claim`.

## Adding a new fixture

1. Add scenario to `engines/ts/src/gen-chess-fixtures.ts`.
2. Run generator + replay.
3. Commit `agent.json`, `model.jsonl`, `expected.jsonl`.

## Two-model series

Shared `ChessWorld` per game, legality-gated turns, **colors alternate every game**, full Faust traces.

```bash
# 20 games to terminal (default package script)
pnpm chess:match

# Explicit
pnpm -C engines/ts exec node --import tsx src/chess-match.ts \
  --deployment ../../case-studies/chess/deployments/kit.yml \
  --model-a kit.minimax-m2.7-229b \
  --model-b kit.mistral-small-4-119b-a8b \
  --games 20 \
  --max-plies 200 \
  --out-dir ../../live/reports/chess-series
```

Color policy: game 1,3,5… → A White / B Black; game 2,4,6… → B White / A Black.

Live terminal display is **cli-chess-inspired** layout ([trevorbayless/cli-chess](https://github.com/trevorbayless/cli-chess))
with a classic wood board palette (not cli-chess’s cyan/slate defaults): white pieces stay `#fff`,
black pieces `#000`, last-move + in-check highlights. Board truth stays in Faust/`chess.js`.

Force color under `tee` with `FAUSTH_CHESS_COLOR=1`. Watch with:

```bash
FAUSTH_CHESS_COLOR=1 pnpm chess:match
# or attach to a running teed log:
tail -f live/reports/chess-series/run.log
```

Outputs under `--out-dir`:
- `summary.json` — series totals (updated after each game)
- `games/game-NN.json` — per-game report + turn traces
- `games/game-NN.partial.json` — mid-game checkpoint every 10 plies
- `traces/game-NN.jsonl` — event-level trace (meta / turn / event / game_end)
- `run.log` — decorated live board stream (when teed)

Success: games reach `ended_by: terminal` with legal moves only; aborts are counted, not hidden.

## Live scenarios (single-agent)

1. Use `case-studies/chess/deployments/kit.yml` (or openrouter-free).
2. Optional: add `smoke.model.jsonl` + `smoke.expected.jsonl` to harness dir.
3. `pnpm -C engines/ts exec node --import tsx src/cli.ts live --deployment ../../case-studies/chess/deployments/kit.yml --scenarios ../../live/scenarios-chess --report ../../live/reports/chess.json`

## Stability gate

See [`results/PROCEDURAL-RELIABILITY.md`](results/PROCEDURAL-RELIABILITY.md). Gate passed 2026-08-04 on Track A fixtures.
