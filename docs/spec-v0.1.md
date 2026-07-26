# Counterbalance Contract — Specification v0.1

**Status:** Normative for Faust Harness v0.1  
**Spec id:** `counterbalance-contract/v0.1`

This document is the source of truth. Golden `expected.jsonl` files MUST be hand-derived from this prose before any engine is treated as correct. Live OpenRouter runs MUST NOT rewrite golden expectations automatically.

---

## 1. Artifacts

### 1.1 `agent.yml` (portable behavior)

Declares identity, state schema defaults, tools (canonical IDs + I/O schemas), gates, verifies, limits, and optional spawn policy.

### 1.2 `deployment.yml` (local binding)

Declares model transport, capability → native bindings, permissions, optional `judge_model`.

### 1.3 Canonical JSON IR

Authoring is YAML. Runtime normative form is **canonical JSON**:

1. UTF-8
2. Object keys sorted lexicographically by Unicode code point
3. No insignificant whitespace (compact separators `,` and `:`)
4. Integers only — no floats, `NaN`, or `Infinity`
5. Arrays preserve declaration order

`state_hash` = lowercase hex SHA-256 of the canonical JSON encoding of the current `state` object.

---

## 2. Lifecycle

Shipped stages, in order, for each tool-using step:

1. **propose** — model (or recorded fixture) emits a tool call or stop
2. **validate** — args match tool input schema; unknown tool → `capability_missing`
3. **authorize** — evaluate gates in declaration order; first failing gate → `deny` with `gate_denied`
4. **execute** — invoke native binding; record result
5. **verify** — evaluate verifies in declaration order (see §4)

Named stubs (may emit events, no required semantics in v0.1): `observe`, `record`, `rebalance`.

### Verdicts

| Verdict | Meaning |
|---------|---------|
| `allow` | Step accepted |
| `deny` | Step rejected; tool not executed (or spawn rejected) |
| `safe_state` | Failure after execute (or authorize policy); enter declared safe state transition |

### Limits

Before propose/execute, if `tool_calls_used >= limits.max_tool_calls` or `steps_used >= limits.max_steps`, emit `deny` with `limit_exceeded` and stop the loop.

---

## 3. Gate language

Gates are data-only predicates evaluated against a **snapshot**:

- `action.name` — tool id
- `action.args` — object
- `state.*` — agent state
- `result.*` — after execute
- `observation.*` — after effect observe
- `judgment.*` — after judge (live only; never in golden fixtures)

### Operators

| Node | Meaning |
|------|---------|
| `{ path, eq }` | deep equality to literal |
| `{ path, eq_path }` | deep equality to another snapshot path |
| `{ path, neq }` | not equal |
| `{ path, lt \| lte \| gt \| gte }` | numeric compare (integers only) |
| `{ all: [pred...] }` | conjunction |
| `{ any: [pred...] }` | disjunction |
| `{ not: pred }` | negation |

Path strings use `.` separators (`action.args.percent`). Missing path → predicate fails (except under `not`).

**Forbidden:** loops, function calls, arithmetic, side effects, string eval, CEL, Rego.

Gates evaluate in **file / array declaration order**. First failure wins.

---

## 4. Verify kinds

| Kind | Track A? | Semantics |
|------|----------|-----------|
| `effect` | Yes | After execute, call `observe` tool; bind result as `observation`; require predicates; else `verify_effect_failed` → `otherwise` verdict (usually `safe_state`) |
| `evidence` | Yes | After execute, require predicates on `result` (e.g. `result.exit_code eq 0`); else `verify_evidence_failed` |
| `absence` | Yes | After execute, require predicates asserting nothing forbidden (e.g. `result.out_of_scope eq 0`); else `verify_absence_failed` |
| `judge` | **No** | Live only. Call second model with rubric; parse JSON `{score, reason}` into `judgment`; invalid JSON → `verify_judge_invalid`; failed require → `verify_judge_failed`. MUST NOT mutate `state` used for `state_hash` in Track A. |

If `otherwise` is omitted, default is `deny` for gates and `safe_state` for verifies.

---

## 5. Closed reason codes

Engines MUST only emit:

`gate_denied` · `capability_missing` · `limit_exceeded` · `verify_effect_failed` · `verify_evidence_failed` · `verify_absence_failed` · `verify_judge_invalid` · `verify_judge_failed` · `schema_invalid` · `safe_state_entered`

---

## 6. Event log

JSON Lines, LF newlines, one event object per line, file ends with a trailing newline.

Required fields:

- `seq` — integer starting at 1
- `ts_logical` — same as `seq` in v0.1 (monotonic step counter; no wall clock)
- `stage` — lifecycle stage name
- `state_hash` — hex SHA-256 of canonical state

Optional: `verdict`, `reason`, `tool`, `args`, `result`, `observation`, `error`.

Events for a successful tool step (happy path):

1. `propose` (with `tool` + `args`)
2. `validate` (`allow`)
3. `authorize` (`allow`)
4. `execute` (`tool`, `args`, `result`)
5. `verify` (`allow`) — one event per verify item that passes; on failure emit `verify` with failing reason and `safe_state`/`deny`, then if safe_state apply transition and emit `record` with `safe_state_entered`

### Deny before execute

1. `propose`
2. `validate` or `authorize` with `deny` + reason  
   (no `execute`)

### Limit exceeded

1. `propose` may be omitted if loop stops before propose  
   Or: emit `authorize`-stage event with `deny` + `limit_exceeded` when the limit check fires at loop head — **v0.1 rule:** emit single event `{ stage: "authorize", verdict: "deny", reason: "limit_exceeded", state_hash }` and stop.

---

## 7. Security / spawn

`agent.spawn` accepts a child harness packet (subset of agent IR).

- Child permissions MUST be ⊆ parent (tighten-only).
- Escalation attempt → `deny` with `gate_denied` (or `schema_invalid` if malformed).
- Orchestrator assigns work; runtime owns trust.

---

## 8. Determinism (Track A)

1. Integers only in state, tool args, and results
2. Canonical JSON as defined in §1.3
3. Logical clock only
4. Declaration order evaluation
5. Closed reason codes
6. No wall-clock, RNG, locale, or environment reads inside gate or computational verify evaluation
7. `judge` forbidden in fixtures

---

## 9. Adapters

| Transport | Use |
|-----------|-----|
| `recorded` | Track A fixtures |
| `ollama` | Local smoke |
| `openai-compatible` | Generic OpenAI API |
| `openrouter` | Track B; free models only (`:free` or `openrouter/free`); fallback list |

---

## 10. Fixture derivation rule

If a golden `expected.jsonl` cannot be derived from this document alone, this specification is underspecified — fix the spec, not the engine.
