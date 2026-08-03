# Chess world (stub — out of MVP)

Long-term Fausth world for stressing **skills, memory provenance, and instincts** under a clear legality gate.

## Intended tools (not implemented)

| Tool | Role |
|------|------|
| `board.observe` | FEN / legal-move list (world truth) |
| `board.move` | Submit a move; illegal → structured deny |
| `game.claim` | Claim mate / draw — requires evidence cells |

## Counterbalance cells (design)

- **Skill:** opening book or tactic skill must be declared before use
- **Memory:** provenance on recalled lines (no invented PENs)
- **Instinct:** “don’t resign without eval” style policy sequences
- **Gate:** illegal move never mutates board; claim-without-evidence fails verify

## Status

`status: draft` in [`world.yml`](world.yml). Lab UI shows the entry with **no run actions** until a harness lands.

Ship greenhouse / coding / adversarial first; implement chess after the Lab run surface is stable.
