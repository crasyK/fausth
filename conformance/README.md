# Conformance fixtures (Track A)

Each fixture directory contains:

| File | Role |
|------|------|
| `agent.json` | Canonical IR (already validated) |
| `model.jsonl` | Recorded model proposals (one JSON object per line) |
| `tools.jsonl` | Recorded tool results / observations keyed by call order |
| `expected.jsonl` | Hand-derived expected event log from `docs/spec-v0.1.md` |

Rules:

- No `judge` verify in golden fixtures.
- Integers only in state / args / results.
- Engines must emit logs byte-identical to `expected.jsonl` (LF, trailing newline, canonical JSON per line).

`fausth replay` and `fausth-py replay` must both exit 0. CI fails if zero fixtures are present.
