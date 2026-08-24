# Chess world

Procedural wind tunnel for Fausth game-world mechanics. **Not** a chess-playing benchmark.

## Tools

| Tool | Role |
|------|------|
| `board.observe` | Canonical FEN, legal UCI moves, position_hash, terminal status |
| `board.move` | Execute legal move; illegal/stale → structured output + harness deny (gated) |
| `game.claim` | Terminal claim (checkmate/draw/stalemate) requires prior observe |

## Adapter

Implementation: [`engines/ts/src/adapters/chess.ts`](../../engines/ts/src/adapters/chess.ts) (chess.js for board truth only).

## Harnesses

| Harness | Path | Purpose |
|---------|------|---------|
| Legality-gated | `case-studies/chess/harnesses/legality-gated/` | observe-before-move sequence, illegal/stale verify deny |
| Permissive control | `case-studies/chess/harnesses/permissive-control/` | no sequence gates; measures raw illegal proposals |
| Oriented | `case-studies/chess/harnesses/oriented/` | orientation + gated surface |

## Track A fixtures

`conformance/fixtures/chess-*` — regenerate with:

```bash
node --import tsx engines/ts/src/gen-chess-fixtures.ts
pnpm fausth replay
```

## Status

`approved` in [`world.yml`](world.yml). See [`case-studies/chess/README.md`](../../case-studies/chess/README.md) for runbook.
