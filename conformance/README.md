# Conformance (spec v0.4 §14)

Both engines must reproduce every expected file here byte for byte.

| Path | What |
|---|---|
| `values.json` | §1 vectors: canonical form, hash, excerpt |
| `harnesses/valid/`, `harnesses/invalid/` | §2–§3, §5.1, §6: harnesses both engines accept (with the expected canonical JSON in `*.expected`) or reject |
| `log.json` | §7 log lines and the §5.3 view |
| `fixtures/<name>/` | recorded runs: `harness.json`, `model.jsonl`, `tools.jsonl`, optional `user.jsonl` / `interrupts.jsonl`, and the expected `expected.log.jsonl` and `expected.requests.jsonl` |

Replay a fixture and compare (`--write` rewrites the expected files):

```bash
pnpm -C engines/ts exec node --import tsx src/cli.ts replay ../../conformance/fixtures/*/
python -m fausth replay conformance/fixtures/*/
```

A new fixture is written from the spec first: its expected files must follow from the spec text,
and both engines must then produce them.
