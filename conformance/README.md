# Conformance (spec v0.6 §14)

Both engines must reproduce every expected file here byte for byte.

| Path | What |
|---|---|
| `values.json` | §1 vectors: canonical form, hash, excerpt; §9.4 vectors: the argument text in both forms, `model_order` (`argument_text`) and `sorted_ascii`, compact and indented |
| `harnesses/valid/`, `harnesses/invalid/` | §2–§3, §5.1, §6, §8.2: harnesses both engines accept (with the expected canonical JSON in `*.expected`) or reject |
| `log.json` | §7 log lines and the §5.3 view |
| `chess-tools.json` | not the engines: the chess tools both hosts bind (`fausth.chess_tools`, `hosts/web/src/chess-tools.ts`), as python-chess results that chess.js must reproduce; written by `engines/py/tests/test_chess_tools.py` with `FAUSTH_WRITE_VECTORS=1` |
| `openai.json` | not the engines: the Chat Completions adapters (§9, §13), request and answer mappings |
| `fixtures/<name>/` | recorded runs: `harness.json`, `model.jsonl`, `tools.jsonl`, optional `user.jsonl` / `interrupts.jsonl` / `reloads.jsonl`, and the expected `expected.log.jsonl` and `expected.requests.jsonl` |

Every harness here declares `spec: harness/0.6`: a 0.6 engine runs no other version (spec, Versions).
The fixtures written for 0.5 were converted when 0.6 dropped 0.5's files; their expected files changed
only where 0.6 differs (the hash, tool order, `args_text`), and `hook-context-rejects-reasoning`
(formerly `hook-context-without-reasoning`) now shows a `pre_request` handler written for 0.5, whose
input schema rejects the reasoning 0.6 puts in `context`, failing. The `v06-*` fixtures cover what 0.6
added: tool order and the hash that sees it, provider call ids, the argument text, the engine's texts,
`replace_context` with `keep` and `wrap`, and the `pre_request` hook input's reasoning and `usage`.
`v06-stop-context` gives a `stop` hook the same `context` and `usage`, after the reply without tool calls
and an earlier `add_context` in its chain; its handler's `input` schema holds the expected values, so a
wrong input fails the hook. That hook hands a title harness to a binding that launches it (§13.1, Appendix
A.7), and `v06-stop-title-run` is the launched run: its own log, its tool-free request. The engines' launch
tests (`test_launch.py`, `launch.test.ts`) run the two together with the binding live and get both
fixtures' expected files.
`v06-argument-text-sorted-ascii` runs the second form of the argument text (§9.4) over the edge cases
that tell Python's writer from ECMAScript's (member order by code point, escapes, integers and floats,
repeated names, a call without `raw`, `{args}` and `{args_indented}`); `v06-argument-text-reload`
switches forms in a reload, and the call logged before keeps its text; `infra-model-raw-mismatch` gives a
`raw` that isn't the call's arguments.

Replay a fixture and compare (`--write` rewrites the expected files):

```bash
pnpm -C engines/ts exec node --import tsx src/cli.ts replay ../../conformance/fixtures/*/
python -m fausth replay conformance/fixtures/*/
```

A new fixture is written from the spec first: its expected files must follow from the spec text,
and both engines must then produce them.
