# Conformance fixtures (Track A)

Each fixture directory contains:

| File | Role |
|------|------|
| `agent.json` | Canonical IR — validated by `engines/ts/src/conformance.test.ts` (part of `pnpm test`) |
| `model.jsonl` | Recorded model proposals: `{type: tool, name, args}` · `{type: stop, message?}` · `{type: invalid, reason, message?}` |
| `tools.jsonl` | Optional **complete** transcript (`call_seq`, `tool`, `args`, `result`). When present (even empty) every invocation — main, observer, recovery, child — consumes it; a missing or different entry is `tool_execution_failed` / `transcript` |
| `user.jsonl` | Optional recorded user answers for `channel: user` tools when there is no transcript (`{tool, call_seq?, args?, result}`) |
| `expected.jsonl` | Expected event log, derivable from [`docs/spec-v0.3.md`](../docs/spec-v0.3.md) |

Rules:

- No `judge` verify in golden fixtures.
- Integers only in state / args / results (non-canonical inputs are allowed only in fixtures that test their rejection).
- Without `tools.jsonl`, world tools come from the reference in-memory world (spec-v0.3 §15.4) and user-channel tools only from `user.jsonl` (none ⇒ unbound ⇒ `capability_missing`).
- Engines must emit logs byte-identical to `expected.jsonl` (LF, trailing newline, canonical JSON per line).
- Fixtures are written by `engines/ts/src/gen-{fixtures,cb-fixtures,finding-fixtures,contract-fixtures}.ts`; expected logs are derived by the normative replay host (`replay.ts`) and every change must be reviewed against the spec text.

`fausth replay` and `fausth-py replay` must both exit 0. CI fails if zero fixtures are present.

### Mutable-cell fixtures (M16)

| Fixture | Expectation |
|---------|-------------|
| `cb-harness-patch-skills-ok` | skills description patch → `rebalance` |
| `cb-harness-patch-security-denied` | permissions ops denied |
| `cb-harness-patch-memory-cautious` | memory ops denied unless `mutable` includes `memory` |
| `cb-decline-skills-ok` | `harness.reflect_skills` decline + yield (the declared completion tool) |
| `cb-reflect-before-yield-denied` | yield without reflect → `sequence_requirement_failed` |

### Module + overlay fixtures (M17 / M18)

| Fixture | Expectation |
|---------|-------------|
| `cb-module-connector-ok` | module-provided `echo.ping` succeeds |
| `cb-module-connector-deny-unsigned` | undeclared tool → `capability_missing` (module surface does not widen) |
| `cb-overlay-selects-variant` | post-overlay narrowed IR denies write |
| `cb-overlay-falls-back` | unmatched overlay keeps full sequences (write-before-plan deny) |

### Contract coverage (spec-v0.3, `v03-*`)

| Fixture | Rule |
|---------|------|
| `v03-verify-fail-not-success` | D8: a verify-failed call is not a success; its transition is discarded |
| `v03-spawn-deny-when-unset` · `v03-spawn-not-permitted` · `v03-spawn-budget-charged` | D6 |
| `v03-spawn-deny-scope-escape` · `v03-spawn-deny-scope-sibling` | D7 |
| `v03-state-write-undeclared-denied` · `v03-checkpoint-key-world-write-denied` | D9 / §8.3 |
| `v03-recovery-gated-terminal-failure` | D10 |
| `v03-user-channel-unbound-denied` · `v03-user-channel-recorded-answer` · `v03-user-answer-missing-infra` | D14 |
| `v03-world-unbound-denied` | unbound world tool ⇒ `capability_missing` |
| `v03-ttl-stale-once` | TTL once per staleness transition |
| `v03-non-canonical-args-denied` · `v03-non-canonical-output-denied` | D3 |
| `v03-output-schema-invalid` · `v03-transcript-mismatch` · `v03-invalid-proposal-cap` | closed failure paths |
| `v03-output-verify-stop-denied` · `v03-output-verify-stop-ok` | agent-level output verifies |
| `v03-sequence-require-state-denied` | sequence `require_state` + checkpoint `unblock` |
| `v03-predicate-operators` · `v03-predicate-own-members` · `v03-predicate-no-array-length` | predicates, MISSING under `not`, D16 |
| `v03-budget-host-day` · `v03-harness-patch-instinct-ok` · `v03-overlays-in-ir-ignored` · `v03-orientation-permitted-only` | budgets, instincts cell, overlays, orientation |
