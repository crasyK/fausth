# Conformance fixtures (Track A)

Each fixture directory contains:

| File | Role |
|------|------|
| `agent.json` | Canonical IR (already validated) |
| `model.jsonl` | Recorded model proposals (one JSON object per line) |
| `tools.jsonl` | Bound recorded tool transcripts (`call_seq`, `tool`, `args`, `result`) |
| `expected.jsonl` | Hand-derived expected event log from `docs/spec-v0.1.md` |

Rules:

- No `judge` verify in golden fixtures.
- Integers only in state / args / results.
- Engines must emit logs byte-identical to `expected.jsonl` (LF, trailing newline, canonical JSON per line).

`fausth replay` and `fausth-py replay` must both exit 0. CI fails if zero fixtures are present.

### Mutable-cell fixtures (M16)

| Fixture | Expectation |
|---------|-------------|
| `cb-harness-patch-skills-ok` | skills description patch → `rebalance` |
| `cb-harness-patch-security-denied` | permissions ops denied |
| `cb-harness-patch-memory-cautious` | memory ops denied unless `mutable` includes `memory` |
| `cb-decline-skills-ok` | `harness.reflect_skills` decline + yield |
| `cb-reflect-before-yield-denied` | yield without reflect → `sequence_requirement_failed` |

### Module + overlay fixtures (M17 / M18)

| Fixture | Expectation |
|---------|-------------|
| `cb-module-connector-ok` | module-provided `echo.ping` succeeds |
| `cb-module-connector-deny-unsigned` | undeclared tool → `capability_missing` (module surface does not widen) |
| `cb-overlay-selects-variant` | post-overlay narrowed IR denies write |
| `cb-overlay-falls-back` | unmatched overlay keeps full sequences (write-before-plan deny) |
