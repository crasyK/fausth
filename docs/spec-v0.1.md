# Counterbalance Contract — Specification v0.1

**Status:** Normative for Faust Harness v0.1.1  
**Spec id:** `counterbalance-contract/v0.1`

This document is the source of truth. Golden `expected.jsonl` files MUST be hand-derived from this prose before any engine is treated as correct. Live OpenRouter runs MUST NOT rewrite golden expectations automatically.

---

## 1. Artifacts

### 1.1 `agent.yml` (portable behavior)

Declares identity, state schema defaults, tools (canonical IDs + I/O schemas), gates, verifies, limits, optional spawn policy, optional `fallback_state` / `recovery`.

`safe_state` is a deprecated alias for `fallback_state` (accepted in v0.1.x; validators SHOULD warn).

### 1.2 `deployment.yml` (local binding)

Declares model transport, capability → native bindings, permissions, optional `judge_model`.

### 1.3 Canonical JSON IR

Authoring is YAML. Runtime normative form is **canonical JSON**:

1. UTF-8
2. Object keys sorted lexicographically by Unicode code point
3. No insignificant whitespace (compact separators `,` and `:`)
4. Integers only — no floats, `NaN`, or `Infinity`
5. Portable integer range: `-(2^53-1) ≤ n ≤ 2^53-1` (signed 53-bit safe integers)
6. Arrays preserve declaration order

`state_hash` = lowercase hex SHA-256 of the canonical JSON encoding of the current `state` object.

Deep equality of values (predicates, recorded-arg matching) MUST use canonical JSON string equality, not language-native object equality.

---

## 2. Lifecycle

Shipped stages, in order, for each tool-using step:

1. **propose** — model (or recorded fixture) emits a tool call or stop
2. **validate** — args match tool input schema; unknown tool → `capability_missing`; bad args → `input_schema_invalid`
3. **authorize** — evaluate gates in declaration order; first failing gate → `deny` with `gate_denied`
4. **execute** — invoke native binding; validate output schema (`output_schema_invalid`); apply `state_transition`; record result; native failure → `tool_execution_failed`
5. **verify** — evaluate verifies in declaration order (see §4)

### Effect observation sub-path

When an `effect` verify runs, observation MUST NOT call the native tool as an ungoverned side channel. Engines MUST follow:

1. **validate_observer** — observer tool exists, `read_only: true`, args match input schema
2. **authorize_observer** — observer id is in the permission allowlist (if present)
3. **observe** — emit an `observe` stage event with tool/args/result; count against `max_tool_calls`
4. **evaluate_evidence** — bind result as `observation` and evaluate `require`

Named stubs (may emit events): `record`, `rebalance`.

### Verdicts

| Verdict | Meaning |
|---------|---------|
| `allow` | Step accepted |
| `deny` | Step rejected; tool not executed (or spawn rejected) |
| `safe_state` | Failure after execute (or authorize policy); enter recovery / fallback flow |

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

Path strings use `.` separators (`action.args.percent`).

### Missing-path semantics (`MISSING` sentinel)

Resolving a path that does not exist yields an internal `MISSING` value, distinct from JSON `null`.

| Operator | Behavior when path is `MISSING` |
|----------|----------------------------------|
| `eq` | fails (unless comparing to an impossible literal — never equals a present value) |
| `neq` | fails (missing is not “not equal”; it is absent) |
| `eq_path` | succeeds only if **both** paths are `MISSING`; otherwise fails if either is missing while the other is present |
| `lt` / `lte` / `gt` / `gte` | fails |
| under `not` | negation of the above |

**Forbidden:** loops, function calls, arithmetic, side effects, string eval, CEL, Rego.

Gates evaluate in **file / array declaration order**. First failure wins.

---

## 4. Verify kinds

| Kind | Track A? | Semantics |
|------|----------|-----------|
| `effect` | Yes | After execute, run governed observation (§2); require predicates; else `verify_effect_failed` → `otherwise` verdict (usually `safe_state`) |
| `evidence` | Yes | After execute, require predicates on `result` (e.g. `result.exit_code eq 0`); else `verify_evidence_failed` |
| `absence` | Yes | After execute, require predicates asserting nothing forbidden (e.g. `result.out_of_scope eq 0`); else `verify_absence_failed` |
| `judge` | **No** | Live only. Call second model with rubric; parse JSON `{score, reason}` into `judgment`; invalid JSON → `verify_judge_invalid`; failed require → `verify_judge_failed`. MUST NOT mutate `state` used for `state_hash` in Track A. |

If `otherwise` is omitted, default is `deny` for gates and `safe_state` for verifies.

---

## 5. Tool schemas and result envelope

### 5.1 Input / output

Executable tools SHOULD declare JSON Schema `input` and `output` objects. When present:

- `validate` MUST reject args that fail `input` (`input_schema_invalid`).
- Unknown properties are rejected unless the schema sets `additionalProperties: true`.
- After native execution, the **output object** MUST match `output` (`output_schema_invalid`).

### 5.2 Result envelope

Native handlers return:

```json
{
  "output": { },
  "state_transition": { "set": { }, "remove": [] }
}
```

Legacy `_state_patch` is forbidden in v0.1.1+.

Sequence:

1. Validate `output` against `tool.output` (if present)
2. Validate `state_transition.set` / `remove` against allowed writable state keys (any key present in initial `state`, unless a future `state_writable` list is declared)
3. Apply transition to agent `state`
4. Emit `execute` with `result` = `output` and `state_hash` of the post-transition state
5. Run verification

---

## 6. Fallback and recovery

`fallback_state` (alias `safe_state`) is **internal bookkeeping only**. It MUST NOT be treated as proof that the physical world is safe.

Optional `recovery` block:

```yaml
recovery:
  on: verify_effect_failed   # reason that triggers recovery
  execute:
    tool: actuator.fan.set
    args: { percent: 0 }
  verify:
    kind: effect
    observe: sensor.fan.read_percent
    require: { path: observation.percent, eq: 0 }
  on_failure: terminal_failure
```

When a verify fails with verdict `safe_state`:

1. If `recovery` is present and `recovery.on` matches the failure reason (or `recovery.on` is omitted), run `recovery.execute` through the normal validate → authorize → execute path (subject to limits).
2. Run `recovery.verify` (governed observation if `effect`).
3. On recovery success: emit `record` with `recovery_succeeded`, then apply `fallback_state` and emit `record` with `safe_state_entered`.
4. On recovery failure: emit `record` with `terminal_failure`; do **not** claim world safety. Still apply `fallback_state` for logical consistency if declared.
5. If no `recovery` block: apply `fallback_state` and emit `record` with `safe_state_entered` (v0.1 bookkeeping-only behavior).

---

## 7. Closed reason codes

Engines MUST only emit:

`gate_denied` · `capability_missing` · `limit_exceeded` · `verify_effect_failed` · `verify_evidence_failed` · `verify_absence_failed` · `verify_judge_invalid` · `verify_judge_failed` · `schema_invalid` · `input_schema_invalid` · `output_schema_invalid` · `tool_execution_failed` · `safe_state_entered` · `recovery_succeeded` · `terminal_failure`

- `schema_invalid` — malformed contract IR / spawn packet
- `input_schema_invalid` / `output_schema_invalid` — tool I/O schema failures
- `tool_execution_failed` — native handler error or recorded-transcript mismatch

---

## 8. Event log

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
5. For each `effect` verify: `observe` then `verify` (`allow`)
6. For evidence/absence: `verify` (`allow`) only

### Deny before execute

1. `propose`
2. `validate` or `authorize` with `deny` + reason  
   (no `execute`)

### Limit exceeded

Emit single event `{ stage: "authorize", verdict: "deny", reason: "limit_exceeded", state_hash }` and stop.

---

## 9. Security / spawn

`agent.spawn` accepts a child harness packet (subset of agent IR).

Tighten-only capability lattice — child MUST be ≤ parent on every governed dimension:

- `child.tools ⊆ parent.tools` (permission allowlist, else declared tool ids)
- `child.filesystem.write_scopes` each must be equal to or a path-prefix child of some parent write scope
- `child.filesystem.read_scopes ⊆ parent.read_scopes` (when parent declares read scopes)
- `child.limits.max_steps ≤ parent.remaining_steps` (when specified)
- `child.limits.max_tool_calls ≤ parent.remaining_calls` (when specified)
- Nested spawn: denied unless parent `spawn.allow_nested: true`
- If parent `spawn.allow` is `false` (or omitted when spawn tool is used without policy allow), deny

Escalation → `deny` with `gate_denied` (or `schema_invalid` if malformed).

Orchestrator assigns work; runtime owns trust.

---

## 10. Determinism (Track A)

1. Integers only in state, tool args, and results (within int53 range)
2. Canonical JSON as defined in §1.3
3. Logical clock only
4. Declaration order evaluation
5. Closed reason codes
6. No wall-clock, RNG, locale, or environment reads inside gate or computational verify evaluation
7. `judge` forbidden in fixtures

### Recorded tool transcripts

`tools.jsonl` entries MUST bind call identity:

```json
{"call_seq":1,"tool":"actuator.fan.set","args":{"percent":40},"result":{"ok":1,"percent":40}}
```

Replay MUST reject if requested tool, args (canonical equality), or call sequence disagree → `tool_execution_failed`.

---

## 11. Adapters

| Transport | Use |
|-----------|-----|
| `recorded` | Track A fixtures |
| `ollama` | Local smoke |
| `openai-compatible` | Generic OpenAI API |
| `openrouter` | Track B; free models only (`:free` or `openrouter/free`); fallback list |

---

## 12. Fixture derivation rule

If a golden `expected.jsonl` cannot be derived from this document alone, this specification is underspecified — fix the spec, not the engine.
