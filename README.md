# Faust Harness (`fausth`)

A harness file declares what a model sees: the prompt, the tools, and the hooks that check
every step. Two small engines (TypeScript and Python) run the same file and must produce
byte-identical logs and model requests.

**Status:** release 0.5.0 implements [`docs/spec-v0.5.md`](docs/spec-v0.5.md), the normative
spec: both engines reproduce every fixture in [`conformance/`](conformance/) byte for byte. Built
along [`docs/build-plan-v0.4.md`](docs/build-plan-v0.4.md). Not production-safe.

The previous system (spec v0.1–v0.3, release `v0.4.0-alpha`) is retired. Its code stays
reachable through the [`v0.4.0-alpha`](https://github.com/crasyK/fausth/releases/tag/v0.4.0-alpha)
tag; its documents are in [`docs/archive/`](docs/archive/).

## Layout

```
docs/          spec-v0.5.md (normative), build plan, design notes
engines/ts/    TypeScript engine (+ OpenAI-compatible adapter)
engines/py/    Python engine (+ adapter, command-line host, python-chess tools)
hosts/web/     the browser host: one HTML page with the TS engine and chess.js tools
conformance/   shared vectors and recorded fixtures both engines must reproduce
examples/      the chess harness (spec §2) with a KIT deployment
```

## Quick start

```bash
corepack enable && pnpm install   # Node 22+
pnpm test                         # TypeScript engine
pip install -e "engines/py[dev]" && pytest engines/py/tests -q
```

## Play the chess harness (Python host)

```bash
pip install -e "engines/py[chess]"
export KIT_AI_API_KEY=...            # the key stays in the environment
python -m fausth run examples/chess/harness.yaml --deployment examples/chess/deployment.kit.yaml \
  --user "Play the best move for White." --log run.log.jsonl
```

`examples/chess/harness.yaml` is the spec's §2 harness. The deployment binds its tools to
python-chess (`fausth.chess_tools`) and names the model; see `engines/py/fausth/host.py` for the
binding kinds (`script`, `recorded`, `model`).

## Play it in the browser (TypeScript host)

```bash
pnpm -C hosts/web build      # writes hosts/web/dist/index.html, one self-contained page
```

Open `hosts/web/dist/index.html`. It replays every conformance fixture with the TS engine (the
same bytes as the Python engine), and it plays `examples/chess/harness.yaml` live with chess.js
tools. Paste a key for an endpoint that accepts browser calls: OpenRouter does; the KIT gateway
allows only its own origin. `pnpm -C hosts/web check` replays the fixtures in headless Chrome.

## Chess tools

`fausth.chess_tools` (python-chess) and `hosts/web/src/chess-tools.ts` (chess.js) give the same
results for the same game, so both hosts show the model the same tokens;
[`conformance/chess-tools.json`](conformance/chess-tools.json) holds the vectors both are tested on.

| Tool | Result |
|---|---|
| `board_observe` | FEN, side to move, whether in check, `position_hash` |
| `board_legal_moves` | every legal move, UCI and SAN |
| `board_move` | plays a UCI move; without `position_hash` the staleness check is skipped |
| `board_check` | `{move, legal}`; if legal: `san`, `gives_check`, and `captures` when it captures; if not: `why`, the move rule below |
| `board_piece` | the piece on a square: `can_move_to` (for a piece of the side not to move: where it could go if it were its turn), `attacks`, `attacked_by`, `defended_by`, `pinned`; its side's `in_check` and castling rights (`castling_right_kingside`, `castling_right_queenside`: the right, not whether castling is legal now) |
| `board_history` | `moves`: the game so far, numbered, in SAN (`last`: only the last n plies); `plies`: how many in all |
| `board_resign` | `{resigned: true}`; the reason goes to the host (`state["resigned"]`, `resigned` in the browser), which ends the game |

For hosts, three functions (TypeScript: `moveProblem`, `renderBoard`, `turnBrief`):

- `move_problem(board, move)`: the sentence for a move that isn't legal, `None` for a legal one. The first
  that applies: (1) `Not a move. Write it in UCI: from-square then to-square, e.g. g1f3, or e7e8q to promote.`,
  (2) `There is no piece on {from}.`, (3) `The {piece} on {from} is your opponent's.`,
  (4) `Name the piece to promote to, e.g. {from}{to}q.`, (5) `Only a pawn reaching the last rank can promote.`,
  (6) `You can't castle {kingside|queenside} now.`, (7) `The {piece} on {from} can't move to {to}.`,
  (8) `You are in check, and {move} doesn't get you out of it.`, (9) `{move} would leave your king in check.`
  `{piece}` reads like `white knight`, `{move}` as the model wrote it.
- `render_board(board, fmt, orientation)`: `fen`, `ascii`, `ascii_fen`, `pieces` (one line per side) or
  `unicode`; `orientation` `white` (White at the bottom) or `mover` (the side to move at the bottom).
- `turn_brief(board, *, board_format, orientation, last_move, note_mode, note_text, note_lines_added)`: the
  text a `user_prompt` handler appends to the user message: the board, the opponent's last move, whether
  the side to move is in check, and the note (`none`, `count`, `count_added`, `full`).

## License

Apache-2.0 — `LICENSE` · `NOTICE`
