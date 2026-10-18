# Conformance (spec v0.5 §14)

Both engines must reproduce every expected file here byte for byte.

| Path | What |
|---|---|
| `values.json` | §1 vectors: canonical form, hash, excerpt |
| `harnesses/valid/`, `harnesses/invalid/` | §2–§3, §5.1, §6: harnesses both engines accept (with the expected canonical JSON in `*.expected`) or reject |
| `log.json` | §7 log lines and the §5.3 view |
| `chess-tools.json` | not the engines: the chess tools both hosts bind (`fausth.chess_tools`, `hosts/web/src/chess-tools.ts`), as python-chess results that chess.js must reproduce; written by `engines/py/tests/test_chess_tools.py` with `FAUSTH_WRITE_VECTORS=1` |
| `fixtures/<name>/` | recorded runs: `harness.json`, `model.jsonl`, `tools.jsonl`, optional `user.jsonl` / `interrupts.jsonl` / `reloads.jsonl`, and the expected `expected.log.jsonl` and `expected.requests.jsonl` |

Replay a fixture and compare (`--write` rewrites the expected files):

```bash
pnpm -C engines/ts exec node --import tsx src/cli.ts replay ../../conformance/fixtures/*/
python -m fausth replay conformance/fixtures/*/
```

A new fixture is written from the spec first: its expected files must follow from the spec text,
and both engines must then produce them.
