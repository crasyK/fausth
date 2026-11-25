# Conformance (spec v0.6 §14)

Both engines must reproduce every expected file here byte for byte.

| Path | What |
|---|---|
| `values.json` | §1 vectors: canonical form, hash, excerpt; §9.4 vectors: the argument text, compact and indented |
| `harnesses/valid/`, `harnesses/invalid/` | §2–§3, §5.1, §6, §8.2: harnesses both engines accept (with the expected canonical JSON in `*.expected`) or reject |
| `log.json` | §7 log lines and the §5.3 view |
| `chess-tools.json` | not the engines: the chess tools both hosts bind (`fausth.chess_tools`, `hosts/web/src/chess-tools.ts`), as python-chess results that chess.js must reproduce; written by `engines/py/tests/test_chess_tools.py` with `FAUSTH_WRITE_VECTORS=1` |
| `openai.json` | not the engines: the Chat Completions adapters (§9, §13), request and answer mappings |
| `fixtures/<name>/` | recorded runs: `harness.json`, `model.jsonl`, `tools.jsonl`, optional `user.jsonl` / `interrupts.jsonl` / `reloads.jsonl`, and the expected `expected.log.jsonl` and `expected.requests.jsonl` |

The fixtures written before 0.6 declare `spec: harness/0.5` and kept their expected files byte for
byte: a 0.6 engine runs them as 0.5.6 did (§15). `v05-on-0.6` shows that with responses that carry
0.6's members (provider ids, usage, malformed arguments); its expected files are also what the
0.5.6 engine writes for it. The `v06-*` fixtures declare `harness/0.6`: tool order and the hash that
sees it, provider call ids, the argument text, the engine's texts, `replace_context` with `keep` and
`wrap`, and the `pre_request` hook input's reasoning and `usage`.

Replay a fixture and compare (`--write` rewrites the expected files):

```bash
pnpm -C engines/ts exec node --import tsx src/cli.ts replay ../../conformance/fixtures/*/
python -m fausth replay conformance/fixtures/*/
```

A new fixture is written from the spec first: its expected files must follow from the spec text,
and both engines must then produce them.
