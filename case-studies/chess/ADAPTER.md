# Chess adapter contract

**Implementation:** [`engines/ts/src/adapters/chess.ts`](../../engines/ts/src/adapters/chess.ts)

## World truth

Board state is owned by `chess.js` inside `ChessWorld`. The model **never** writes FEN, legality, or terminal status directly.

## State machine

```
observe → canonical state + position_hash + observed=1
move    → requires optional position_hash; mutates board if legal; observed=0 after move
claim   → requires observed=1 + terminal position + matching kind
```

## Tools

### `board.observe`

Returns: `fen`, `side`, `legal_moves` (UCI sorted), `position_hash` (16-hex sha256 prefix), `in_check`, `material_*`, `game_over`, `result`.

Sets harness state: `observed=1`, `position_hash`, `fen`, `game_over`, `side`.

### `board.move`

Args: `move` (UCI, e.g. `e2e4`, `e7e8q`), optional `position_hash`.

| Outcome | `ok` | `illegal` | `stale` | Board mutated |
|---------|------|-----------|---------|---------------|
| Legal | 1 | 0 | 0 | yes |
| Illegal | 0 | 1 | 0 | no |
| Stale hash | 0 | 0 | 1 | no |

Gated harnesses verify `illegal=0` and `stale=0` → **deny** on failure.

### `game.claim`

Args: `kind` ∈ `checkmate` | `draw` | `stalemate`.

Requires `state.observed === 1` (gate) and world terminal status matching kind.

## Deployment bindings

```yaml
board.observe: { native: stub.board_observe }
board.move:    { native: stub.board_move }
game.claim:    { native: stub.game_claim }
```

Registered in [`engines/ts/src/adapters/registry.ts`](../../engines/ts/src/adapters/registry.ts).

## Replay determinism

`replayHashFromMoves(moves, startFen)` hashes final FEN after a move list. Track A golden logs are byte-stable for fixed proposals.

## Extension points

1. **Engine-bounded candidates:** add `board.candidates` tool returning deterministic shortlist before model chooses.
2. **Python parity:** mirror in `engines/py/fausth/` if dual-runtime required.
3. **Live scenarios:** `live/scenarios-chess/` + KIT deployment template.

## Tests

- Unit: `engines/ts/src/adapters/chess.test.ts`
- Conformance: `conformance/fixtures/chess-*`
- Generator: `engines/ts/src/gen-chess-fixtures.ts`
- Library smoke: `pnpm ci:library-smoke` includes the three chess harnesses
