# Counterbalance Contract — Executable Specification v0.3

**Status:** **Normative** for Fausth `0.3.x` engines (TypeScript `engines/ts`, Python `engines/py`).
**Spec ids accepted:** `counterbalance-contract/v0.1`, `counterbalance-contract/v0.2`, `counterbalance-contract/v0.3`.
**Schema:** [`../schema/counterbalance-contract.v0.1.json`](../schema/counterbalance-contract.v0.1.json) (the executable IR schema; see §2.1).

This document is the single normative description of what an engine does with a harness. It
consolidates [`spec-v0.1.md`](spec-v0.1.md) (baseline) and [`spec-v0.2.md`](spec-v0.2.md)
(Counterbalance bridge, structured denies) and **overrides them wherever they conflict**. Golden
`expected.jsonl` files under `conformance/fixtures/` MUST be derivable from this text; if one is
not, this document is underspecified and must be fixed first (spec-first rule, v0.1 §12).

Everything below is an engine obligation unless it says "host". A *host* is the program that
embeds an engine (CLI, CI script, server) and supplies tool implementations, the user channel,
the model, and the judge. Hosts supply implementations; the engine routes calls. The agent sees
the same tokens and tools on every host because everything the engine treats specially is
declared in the harness and specified here.

Conformance keywords MUST / SHOULD / MAY are used as in RFC 2119.

---

## 0. Design invariants

1. **No name magic (D11).** No tool id, state key, file path or argument name has engine-defined
   meaning unless this document defines it. The only reserved identifiers are the *contract
   tools* of §12 (`agent.spawn`, `harness.propose_skills_patch`, `harness.decline_skills_patch`,
   `harness.reflect_skills`) and the snapshot roots of §3.
2. **Honest verdicts (D8).** `deny` before execution means "not executed". `deny` / `safe_state`
   at or after execution means "executed, outcome rejected": the call is not successful and its
   state transition is not committed. External side effects are never claimed to be undone.
3. **Closed vocabularies (D12).** Every stage, verdict, reason code and `failure.kind` an engine
   emits is listed in §13. Emitting anything else is non-conformant.
4. **Structured denies (D13).** Engine-authored event content is structured data only. Engines
   never emit English prose hints. Host/world text (tool output, host error messages) is world
   feedback: bounded and secret-redacted (§14).
5. **Security is platform-only.** An orchestrator (spawn) may assign work but never mint trust:
   children are tighten-only (§10) and are charged to the parent.

---

## 1. Values: canonical JSON

### 1.1 Value domain (D3)

A *canonical value* is `null`, a boolean, a string, an integer, an array of canonical values, or
an object with string keys and canonical values.

- **Numbers:** a JSON number is canonical iff its mathematical value is an integer `n` with
  `-(2^53-1) ≤ n ≤ 2^53-1`. `1.0`, `1e3` and `-0` are the integers `1`, `1000`, `0`.
  Non-integral numbers, `NaN` and `±Infinity` are **not** canonical.
- **Strings:** MUST be well-formed Unicode (no unpaired surrogates).
- **Absent members:** a host-language "undefined" object member is treated as absent.

### 1.2 Serialization (D1)

UTF-8; no insignificant whitespace (separators `,` and `:`); object keys sorted ascending by
**Unicode code point** (not UTF-16 code unit); arrays keep their order; integers in shortest
decimal form (`-0` → `0`); strings escaped as JSON (`"` `\` and U+0000–U+001F; U+0000–U+001F use
`\b \f \n \r \t` where defined, otherwise `\u00XX` lowercase); all other characters literal.

`state_hash` = lowercase hex SHA-256 of the canonical encoding of the current `state` object.

Deep equality (predicates, transcript argument matching) is canonical-string equality.

Wherever this document says an engine *sorts* strings (tool ids, keys, paths), the order is the
Unicode code point order of §1.2.

### 1.3 Where non-canonical values are rejected

A non-canonical value MUST be rejected **where it enters**, with a closed reason code, and MUST
NOT crash a run later (e.g. when hashing state or writing the log):

| Entry point | Result |
|-------------|--------|
| Harness IR (any field) | validation error (§2.6) |
| Model proposal `args` | `propose` / `deny` / `input_schema_invalid`, `failure: {kind: "non_canonical", path}` (§5.3) |
| Tool output / state transition (incl. recorded transcripts, user-channel answers) | `execute` / `deny` / `output_schema_invalid`, `failure: {kind: "non_canonical", path}` |
| Effect observer output | `observe` / `deny` / `output_schema_invalid` |
| Judge result | `verify` / `verify_judge_invalid`, `failure: {kind: "judge", code: "invalid"}` |

`path` is a JSON-pointer-like string rooted at `$` (object members `.<key>`, array items
`[<index>]`), e.g. `$.result.score`.

### 1.4 String length (D2)

Every string length or truncation that affects an event or a predicate counts **Unicode code
points**. `excerpt(s, n)` = `s` if it has at most `n` code points, else its first `n` code points
followed by the literal suffix `…[truncated]`.

---

## 2. Harness IR

### 2.1 Shape and versions

There is one executable IR shape (the flat "v0.1 IR family"), validated by
`schema/counterbalance-contract.v0.1.json`. The `spec` field MUST be one of
`counterbalance-contract/v0.1`, `/v0.2`, `/v0.3`; all three denote this IR and these semantics
(the id records authoring vintage, not a different engine).

The **agent/world/exchange authoring shape** sketched in spec-v0.2 §1 and drafted in
`schema/counterbalance-contract.v0.2.json` is **not loadable** in 0.3: documents using top-level
`agent` / `world` / `exchange` are rejected by validation. It remains the design direction; see
[`spec-v0.3-draft.md`](spec-v0.3-draft.md) §A for the planned translation.

Top-level fields (closed set; anything else is a validation error):

| Field | Meaning |
|-------|---------|
| `spec`, `name` | Required. |
| `state` | Required object. Declares the memory keys (§8.4) and their initial values. |
| `tools` | Required, ≥ 1. Tool declarations (§2.3). |
| `gates` | Authorize predicates (§6.2). |
| `limits` | `max_steps`, `max_tool_calls` (integers ≥ 0, default 1000 each), `timeout_ms` (host-enforced wall clock, not Track A), `continue_after_deny` (boolean, default false), `max_observation_chars` (integer ≥ 1, default 8000; §14). |
| `fallback_state` | Bookkeeping state merged into `state` when the safe flow runs (§11). `safe_state` is a deprecated alias. |
| `recovery` | §11. |
| `permissions` | §4. |
| `spawn` | §10. |
| `counterbalance` | Bridge: `sequences`, `invalidate_after`, `completion`, `checkpoints`, `orientation`, `output_verifies`, `memory_provenance`, `intervention_budget`, `triggers`, `memory_notes` (§8). Closed at every level. |
| `mutable` | Mutable cells `skills` / `memory` / `instincts` (§12). |
| `instinct_text` | Harness-authored disposition text. Hosts SHOULD include it verbatim in the model's system context (§15.3). |
| `overlays` | Model-adaptive, narrow-only overlays resolved by the host before the run (§4.4). The engine ignores this field at run time. |

### 2.2 Loading and normalization (D4)

- YAML is parsed with **YAML 1.2 core schema** semantics: `yes/no/on/off` are strings, `012` is
  the integer 12, `0o17` is 15, duplicate mapping keys are an error. YAML values that are not
  canonical (e.g. `.inf`, `1.5`) fail validation (§1.3).
- Every top-level YAML key is carried into the IR (unknown keys are not dropped; validation
  rejects them).
- **Normalization** (applied identically by every loader and by the engine before a run):
  if `safe_state` is present and `fallback_state` is absent, `fallback_state := safe_state`.

### 2.3 Tools

```yaml
tools:
  - id: user.approve          # unique, non-empty
    description: ...          # optional; mutable via skills patches
    read_only: false          # true = no world side effects (required for observers)
    channel: user             # "world" (default) | "user"   (§9)
    input:  { ...JSON Schema }  # optional
    output: { ...JSON Schema }  # optional
    verify: [ ... ]             # optional (§7)
    effects:                    # optional declared state effects (§6.3 step 4)
      - when: { path: result.approved, eq: 1 }   # optional predicate on {action, state, result}
        set: { plan_approved: 1 }
```

**Declared effects** carry harness memory semantics in the IR: which result means "tests
pass", which answer means "plan approved", what yielding a phase records. Hosts and engines
never write a state key because of its name (D11); a host adapter reports what happened in the
world (its `output`, and only world-derived transitions such as counters), and the harness maps
results to memory through `effects`.

JSON Schema dialect: 2020-12 with **standard semantics** — the engine injects no defaults (a
missing `additionalProperties` allows extra members; a missing `type` constrains nothing; this
supersedes spec-v0.1 §5.1's closed-by-default rule). Authors who want closed inputs write
`additionalProperties: false` (validators warn when an input schema omits it). Tool arguments
must still be a JSON object (§6.1) and outputs must still be objects (§6.3). `format` is an
annotation only (never validated). A top-level `$id` is ignored.

### 2.4 Reserved contract tools

Only the ids in §12 and `agent.spawn` (§10) carry engine semantics, and only when the harness
declares a tool with that id. They are otherwise ordinary tools (they need input/output schemas,
permissions, bindings).

### 2.5 State

`state` declares the harness memory. **Only declared keys are writable** (§6.3 step 5). Values are
canonical.

### 2.6 Validation (normative)

A harness is valid iff it satisfies the schema **and** all of the following. Validators MUST
report every violation they find.

1. The whole IR is canonical (§1.1).
2. Tool ids are unique.
3. `permissions.tools` ⊆ declared tool ids (SPEC-16).
4. Filesystem scopes in `permissions.filesystem` normalize (§4.2).
5. Every effect observer (tool verifies and `recovery.verify`) is a declared tool with
   `read_only: true` and `channel: world`, and its input schema accepts `{}`.
6. `recovery.execute.tool` is declared.
7. `counterbalance.sequences[*]`: `action`, every `require_prior_tools` / `require_prior_any_of`
   entry is declared.
8. `counterbalance.invalidate_after[*]`: exactly one of `action` (declared) or `ttl_steps`
   (integer ≥ 1); `memory_keys` non-empty and ⊆ `state` keys.
9. `counterbalance.completion.tool` is required and declared.
10. `counterbalance.checkpoints[*]`: `tool` declared, declared with `channel: user` (D14), listed
    at most once; `allow_set_keys` ⊆ `state` keys.
11. `counterbalance.memory_provenance` keys ⊆ `state` keys.
12. `counterbalance.output_verifies[*]` are `kind: output`.
13. Overlay tools ⊆ the base permitted set; overlay limits are integers ≥ 0 (`timeout_ms` ≥ 1).
14. Predicate path roots are allowed for their context (§3.2).
15. Every tool `input` / `output` schema compiles.
16. Every `effects[*].set` key is a declared state key; a tool that is not a checkpoint tool may
    not set a checkpoint key, and a checkpoint tool may set only its `allow_set_keys`;
    `effects[*].when` uses only the roots `action`, `state`, `result`.

Validators SHOULD warn (not fail) when `safe_state` is used, or when `agent.spawn` is declared
but `spawn.allow` is not `true` (every spawn would be denied).

---

## 3. Snapshots and predicates

### 3.1 Predicate language

As spec-v0.1 §3: `{path, eq}`, `{path, eq_path}`, `{path, neq}`, `{path, lt|lte|gt|gte}` (integer
literal; the value must be an integer, else the leaf is false), `{all: [...]}`, `{any: [...]}`,
`{not: p}`. Missing-path semantics (MISSING sentinel) are unchanged:

| Operator | Path MISSING |
|----------|--------------|
| `eq`, `neq`, `lt`, `lte`, `gt`, `gte` | false |
| `eq_path` | true iff both paths MISSING |
| under `not` | negation of the above (so `not {path: x, eq: 1}` is **true** when `x` is MISSING) |

### 3.2 Path resolution (D16) and roots

A path is split on `.`. The first segment is a snapshot root; each further segment selects an
**own member of a JSON object**. Resolution yields MISSING when a segment is absent, or when the
current value is not an object (arrays, strings, numbers, booleans and `null` have no members:
there is no implicit `.length` and no array indexing; inherited/prototype members never resolve).

| Context | Allowed roots | Snapshot |
|---------|---------------|----------|
| `gates[*].when` / `require` | `action`, `state` | `{action: {name, args}, state}` |
| `sequences[*].require_state` | `action`, `state` | `{action, state}` |
| `completion.require` | `state` | `{state}` (+ `action: {name, args: {}}`) |
| verify `effect` | `action`, `state`, `result`, `observation` | after execute |
| verify `evidence` / `absence` | `action`, `state`, `result` | after execute |
| verify `output` (tool) | `action`, `state`, `result`, `message` | after execute |
| verify `judge` | `action`, `state`, `result`, `judgment` | after execute |
| `output_verifies` (agent, stop) | `state`, `message` | §8.6 |

During verification `state` is the provisional post-transition state (§6.3 step 6).

---

## 4. Permissions

### 4.1 Tool permissions (D5)

`permissions.tools` absent ⇒ every declared tool is permitted. `permissions.tools: []` ⇒ none.
Otherwise exactly the listed tools. This applies to **every** tool including `agent.spawn`
(D6/SPEC-11) and effect observers.

The *permitted set* is `declared ∩ permitted`; it is what hosts offer to the model and what
orientation advertises (§8.5).

### 4.2 Filesystem scopes (D7)

`permissions.filesystem.write_scopes` / `read_scopes` are path scopes. Normalization of a scope
string `s` (after replacing `\` by `/` and trimming surrounding blanks):

1. `s` ∈ {`.`, `./`, `*`, `**`} ⇒ the **root scope** (explicit root grant). These are the only
   root forms.
2. Reject: empty string, NUL, a leading `/` (absolute), a drive prefix `X:`, any `.git`
   component, and (authoring rule) any `*` outside the root forms — scopes are paths, not globs.
3. POSIX-normalize: drop empty segments (`//`, trailing `/`) and `.` segments; resolve `..`
   against the preceding segment. A `..` with nothing to pop is an **escape** ⇒ reject. If the
   result is empty (e.g. `src/..`) ⇒ reject (root only by explicit grant).
4. The normal form is the segments joined by `/` (`src`, `src/`, `./src`, `src//` all ⇒ `src`).

**Containment:** scope `P` covers scope `C` iff `P` is root, or `C` is not root and `P`'s
segments are a segment-wise prefix of `C`'s segments (`src` covers `src/a`, not `srcx`). Root is
covered only by root.

Hosts enforcing scopes on tool paths (world adapters) MUST use the same normalization and
containment; a tool **path** is normalized the same way except that any `..` component is
rejected outright. In the TS engine both the engine (`scopes.ts`) and the world adapters use
`adapters/sandbox-path.ts`.

### 4.3 Secrets and protected paths (host obligations)

`permissions.secrets` (`paths`, `values`, `deny_write_contains`, default true) and
`permissions.protected_paths` are **world-side declarations enforced by the host's world
adapter**; the engine does not read files. A conforming host world adapter:

- MUST treat each declared secret value, and the content of each declared secret path, as a
  secret. When `deny_write_contains` is not `false`, a write whose content contains a secret MUST
  NOT be performed and the tool output MUST report it (`secret_leak: 1`).
- MUST snapshot each protected path at world initialization; a direct write to it MUST NOT be
  performed and MUST be reported (`protected_modified: 1`); a mutation by any other tool that
  changes its content MUST be rolled back and reported.
- Harnesses turn these reports into verdicts with `absence` verifies
  (`{path: result.secret_leak, eq: 0}`, `{path: result.protected_modified, eq: 0}`).

The engine itself redacts declared `secrets.values` from world feedback (§14).

### 4.4 Overlays

`overlays[*]` = `{when_model, tools?, limits?, prompt_hint?}`. A host resolving overlays picks
the first overlay whose `when_model` contains the deployment model id and produces a new IR:

- `tools` MUST be ⊆ the base permitted set; the result sets `permissions.tools` to it. Tool
  **declarations are kept** so references (observers, sequences, completion) stay valid.
- each `limits.*` MUST be an integer ≥ 0 (`timeout_ms` ≥ 1) and MUST NOT exceed the **effective**
  base value (an unset `max_steps` / `max_tool_calls` is 1000; an unset `timeout_ms` is
  unbounded). Widening is an error.
- the result has no `overlays` field. `prompt_hint` is harness-authored host teaching text.

---

## 5. The exchange loop

### 5.1 Run state

An engine run keeps: `state` (from the IR), `steps_used = 0`, `tool_calls_used = 0`, the set of
**successful tools** (§6.5), per-key memory provenance (§8.4), the count of consecutive invalid
proposals, and per-contract-tool attempt counters (§12). None of this is part of the harness IR.

### 5.2 Iteration

The engine enforces the harness limits itself. A host MAY pass a step cap for one run; it
narrows `max_steps` (effective `max_steps = min(limits.max_steps, cap)`), so reaching it is the
same visible `limit_exceeded` event — a run never stops silently. For each iteration:

1. **Limits.** If `steps_used ≥ max_steps` or `tool_calls_used ≥ max_tool_calls`: emit
   `authorize`/`deny`/`limit_exceeded` (no `tool`) and **end the run**.
2. `steps_used += 1`.
3. **TTL invalidation** (§8.4).
4. **Intervention budget** (§8.7).
5. **Orientation** if `counterbalance.orientation.emit_each_step` is `true` (§8.5).
6. **Proposal** from the model (or the recorded fixture):
   - **stop** (or no proposal): §5.4.
   - **invalid**: §5.5.
   - **tool**: process the action (§6) with origin `model`. Outcome: *complete*, *safe_state* or
     *infra* ⇒ end; *denied* ⇒ end unless `continue_after_deny` is `true`; *success* ⇒ next
     iteration.

### 5.3 Tool proposals

If `args` is not canonical, emit `propose`/`deny`/`input_schema_invalid` with `tool` and
`failure: {kind: "non_canonical", path}` (no `args`), and treat it as *denied*. Otherwise emit
`propose` with `tool` and `args` (no verdict) and continue with §6.

### 5.4 Stop proposals

Let `m` be the stop message if it is a non-empty string. Emit `propose`/`allow`, with
`observation: {stop_message: excerpt(m, 500)}` when `m` exists. If `m` exists and
`counterbalance.output_verifies` is non-empty, run them (§8.6). If one fails with `deny` and
`continue_after_deny` is `true`, continue with the next iteration; if it fails with `safe_state`,
run the safe flow (§11). Otherwise the run ends.

### 5.5 Invalid proposals

An invalid proposal carries a reason from the closed model-protocol set (`empty_choices`,
`unknown_transport_tool`, `invalid_tool_arguments_json`, `tool_arguments_not_object`,
`tool_arguments_non_canonical`, `multiple_tool_calls`, `empty_proposal`). Emit
`propose`/`deny` with reason `empty_proposal` when the model answered without any tool call
(reason `empty_proposal`), and `invalid_proposal` for every other reason (a malformed call is a
protocol failure, not silence), with
`observation: {invalid_reason: excerpt(reason, 500), stop_message: excerpt(text, 500) | null}`.
Hosts MUST NOT turn invalid proposals into `stop`. The run ends unless `continue_after_deny` is
`true`, and always ends after **two consecutive** invalid proposals (a tool proposal resets the
count).

---

## 6. Processing an action

Stages run in this order. A deny at any stage ends the processing (*denied*), unless noted.
`tool` and `args` are carried on every event of the action unless noted.

### 6.1 validate

1. Tool not declared ⇒ `validate`/`deny`/`capability_missing`.
2. Tool not permitted (§4.1) ⇒ `validate`/`deny`/`capability_missing`.
3. `args` is not an object, or fails the input schema ⇒ `validate`/`deny`/`input_schema_invalid`.
   (A schema that does not compile ⇒ `validate`/`deny`/`schema_invalid`.)
4. The tool is not **bound** — the run is not in recorded-transcript mode (§15.1) and the host
   supplied no handler for it (world channel: no native binding; user channel: no user-channel
   binding, §9) ⇒ `validate`/`deny`/`capability_missing`,
   `failure: {kind: "channel_unbound", channel: "world"|"user"}`. Nothing is executed.
5. Emit `validate`/`allow`.

### 6.2 authorize

1. **Gates** in declaration order; the first gate whose `when` holds (or has no `when`) and whose
   `require` fails ⇒ `authorize`/`<otherwise>`/`gate_denied` (`otherwise` ∈ {`deny`,
   `safe_state`}, default `deny`). `safe_state` ⇒ safe flow (§11) with trigger `gate_denied`.
2. **Spawn** (`agent.spawn` only): §10.
3. **Contract tools** (§12 ids only): §12.
4. **Sequences** (§8.1) ⇒ `authorize`/`deny`/`sequence_requirement_failed` + `failure`.
5. **Completion** (§8.2) ⇒ `authorize`/`deny`/`completion_gate_failed` + `failure`.
6. **Checkpoint authority on the request** (D9, §8.3): ⇒
   `authorize`/`deny`/`checkpoint_authority_failed`, `failure: {kind: "checkpoint_key", checkpoint_key}`.
7. **Tool-call budget:** `tool_calls_used ≥ max_tool_calls` ⇒ `authorize`/`deny`/`limit_exceeded`
   (only reachable for recovery actions; model actions are covered by §5.2 step 1).
8. Emit `authorize`/`allow`.

### 6.3 execute

1. `tool_calls_used += 1`.
2. **Invoke** (§15.1): the recorded transcript if present, else the host handler.
   - A transcript mismatch or an exhausted transcript ⇒ `execute`/`deny`/`tool_execution_failed`,
     `failure: {kind: "transcript", code: "mismatch"|"exhausted", call_seq}`.
   - A host **infrastructure** failure — the handler throws an adapter error (closed codes
     `binding_missing`, `adapter_unresolved`, `spawn_not_allowed`, `recorded_response_missing`,
     `user_channel_unavailable`, `host_session_failed`) ⇒ `execute`/`deny`/`infra_failure`,
     `failure: {kind: "adapter", code}`. The outcome is *infra*: nothing is committed and **the
     run ends** regardless of `continue_after_deny` (infrastructure is never model behaviour).
   - Any other exception from the handler (the tool itself failed) ⇒
     `execute`/`deny`/`tool_execution_failed`, `failure: {kind: "host_error"}`.
   The host's error message, if any, is carried in `error` as world feedback (§14).
3. **Envelope.** The handler returns `{output, state_transition?}`; a bare object without an
   `output` member is wrapped as `{output: <object>}`. Anything else (non-object `output`,
   unknown envelope members, `_state_patch`, `set` not an object, `remove` not an array of
   strings) ⇒ `execute`/`deny`/`output_schema_invalid`, `failure: {kind: "malformed_envelope"}`.
   Then, in order: a non-canonical output or transition value ⇒ `output_schema_invalid` +
   `non_canonical`; the output (world feedback) is sanitized (§14); output schema failure ⇒
   `output_schema_invalid`.
4. **Declared effects.** For each `effects` entry in declaration order whose `when` holds (or has
   no `when`) on `{action, state, result: <sanitized output>}`, its `set` entries are merged
   into the transition's `set`, overriding host-returned values for the same keys.
5. **Transition authority (D9, post-execution, pre-commit).** For each key written (`set` keys
   in code point order, then `remove` entries in order): an undeclared key ⇒
   `execute`/`deny`/`state_write_denied`, `failure: {kind: "state_key", state_key}`; a
   checkpoint key written by a tool that does not own it, or a key outside the executing
   checkpoint tool's `allow_set_keys` ⇒ `execute`/`deny`/`checkpoint_authority_failed`,
   `failure: {kind: "checkpoint_key", checkpoint_key}`.
6. **Provisional transition.** `state' = (state ∪ set) − remove` becomes the current state.
7. Emit `execute`/`allow` with `result` = output (`state_hash` of `state'`).
8. `agent.spawn` with a child proposal list: run the child (§10).

Every deny in this stage means: the call was attempted/executed, the result is rejected, nothing
is committed, the call is not successful. Side effects are not undone.

### 6.4 verify

Run the tool's `verify` list in order (§7) — and, for a recovery action, `recovery.verify`
after it (§11). On the **first failure**: discard the provisional transition (restore the
pre-call state and provenance), **then** emit the failure event (so its `state_hash` shows the
discarded transition), and stop verifying. Failure with `safe_state` ⇒ safe flow (§11) with the
verify's reason as trigger (not for recovery actions) and the action's outcome is *safe_state*;
failure with `deny` ⇒ *denied*.

If the list is empty, emit `verify`/`allow` with no `tool`.

If an effect observation fails with an infrastructure failure (`observe`/`deny`/`infra_failure`),
the provisional transition is discarded and `verify`/`deny`/`infra_failure` (with the same
`failure`) is emitted; the outcome is *infra* (the run ends; no safe flow, nothing is claimed).

### 6.5 commit and success (D8)

When every verify passed: the transition is committed, provenance is updated (§8.4), and the tool
is added to the **successful tools**. Only such calls count as successful anywhere in the
contract (sequences, orientation, contract-tool exclusivity, audits, host metrics). Then, in
order:

1. Contract-tool effects (§12): `rebalance`/`allow`/`harness_patch_applied` or
   `record`/`allow`/`harness_patch_declined`.
2. Action-triggered invalidation (§8.4): `record`/`allow`/`memory_stale`.
3. If the tool is `counterbalance.completion.tool` (and the origin is not recovery): emit
   `record`/`allow`/`run_complete` with `tool`; the action's outcome is *complete*.

Otherwise the outcome is *success*.

---

## 7. Verify kinds

| Kind | Track A | Default `otherwise` | Pass condition | Failure reason |
|------|---------|---------------------|----------------|----------------|
| `effect` | yes | `safe_state` | governed observation succeeds and `require` holds | `verify_effect_failed` |
| `evidence` | yes | `safe_state` | `require` holds | `verify_evidence_failed` |
| `absence` | yes | `safe_state` | `require` holds | `verify_absence_failed` |
| `output` | yes | `deny` | `require` holds on the message snapshot (§8.6) | `verify_output_failed` |
| `judge` | **no** | `deny` | judge available, result valid, `require` holds | `verify_judge_invalid` / `verify_judge_failed` |

`otherwise` ∈ {`deny`, `safe_state`} (an `allow` fallback would let a failed check count as
success and is rejected by the schema).

Events (`tool` = the verified tool):

- pass: `verify`/`allow` with `result` (evidence, absence, output) or `observation` (effect,
  output: `{message}`) or `result: <judgment>` (judge).
- fail: `verify`/`<otherwise>`/`<reason>` with `args` and `result` (evidence, absence, output),
  `observation` (effect: the observation; output: `{message}`), judge: `result: <judgment>` or
  `failure: {kind: "judge", code: "unavailable"|"invalid"}` (+ `error` = excerpt of the raw judge
  text for `invalid`).

**Governed observation (effect).** With `observer = verify.observe`, args `{}`, checked in order:
not declared / not `read_only` / not world-channel ⇒ `validate`/`deny`/`capability_missing`;
input schema rejects `{}` ⇒ `validate`/`deny`/`input_schema_invalid`; unbound (no handler, not in
transcript mode) ⇒ `validate`/`deny`/`capability_missing` with
`failure: {kind: "channel_unbound", channel: "world"}`; not permitted ⇒
`authorize`/`deny`/`capability_missing`; `tool_calls_used ≥ max_tool_calls` ⇒
`authorize`/`deny`/`limit_exceeded`. Otherwise `tool_calls_used += 1`, invoke (as §6.3 steps 2–3;
failures as `observe`/`deny`/`tool_execution_failed`, `infra_failure` or `output_schema_invalid`),
then emit `observe`/`allow` with `tool: observer`, `args: {}`, `result: <output>`. The observer's
`state_transition`, if any, is ignored. Gates do not apply to observers. If the observation fails
(other than by infrastructure, §6.4), the verify fails: `verify`/`<otherwise>`/
`verify_effect_failed` with `failure: {kind: "observation_failed"}`.

**Judge.** The judge is a host function (live only). If the host provides none (always the case
in Track A), the verify fails with `code: "unavailable"`. The judge result MUST be an object
`{score: <integer>, reason: <string>}`; anything else (including non-integral scores) fails with
`code: "invalid"`. The judgment snapshot is `{score, reason: excerpt(reason, 500)}`. Judges never
mutate `state`.

---

## 8. Counterbalance bridge

### 8.1 Sequences

For each sequence whose `action` is the proposed tool (declaration order), the first unmet
requirement denies with `sequence_requirement_failed`:

1. `require_prior_tools`: every listed tool is a successful tool (§6.5), else
   `failure: {kind: "missing_prior_tools", missing_prior_tools: [sorted missing]}`.
2. `require_prior_any_of`: at least one listed tool is successful, else
   `failure: {kind: "missing_prior_any_of", options: [sorted options]}`.
3. `require_state` holds, else `failure: {kind: "predicate", failed: [...]}` (§13.3).

### 8.2 Completion and terminal tool

`counterbalance.completion = {tool, require?}` declares the run's **terminal tool**. A proposal
of `tool` is denied with `completion_gate_failed` and a `predicate` failure while `require` does
not hold. After the terminal tool succeeds (§6.5) the engine emits `run_complete` and ends the
run. Without a `completion` block no tool is terminal (the run ends by stop, limits, deny or
safe state). There is no default terminal tool id. (A phase harness that ends by yielding
declares its yield tool here.)

### 8.3 Checkpoints and state authority (D9, D14)

`counterbalance.checkpoints = [{tool, allow_set_keys}]`. Each checkpoint tool MUST be a
user-channel tool (§9). A key listed in some `allow_set_keys` is a **checkpoint key** (a user
decision, e.g. an approval or a clarification); its owners are the checkpoint tools listing it.

- **On the request (authorize):** a checkpoint tool's `args.set`, when it is an object, names
  the state changes the agent asks the user for; every key MUST be in that tool's
  `allow_set_keys`.
- **On the transition (pre-commit, §6.3 step 5):** a checkpoint tool may write only its
  `allow_set_keys`; a checkpoint key may be written only by one of its owners; any tool may write
  only declared state keys.

Predicate failures name an `unblock` (v0.2 §4) when a checkpoint covers a failing `eq` leaf.

### 8.4 Memory, provenance and invalidation

Every declared state key has engine-side provenance `{status, updated_at_step}`
(`status` ∈ `current`, `stale`, `contradicted`, `unknown`). Initial values: from
`counterbalance.memory_provenance[key]` when declared (missing `updated_at_step` = 0, missing
`status` = derived as next); otherwise `status = current` if the initial value is *fresh* — not
`0`, `false`, `null` or `""` — else `stale`, and `updated_at_step = 0`. Provenance is not part of
the harness IR and is never written back into it.

On **commit** (§6.5) every written key gets `updated_at_step = steps_used` and `status =
current` if the written value is fresh, else `stale`; removed keys become `stale`.

**Action invalidation:** after `action` succeeds, every key of every `invalidate_after` rule with
that `action` is set to `0` and marked `stale`; one `record`/`allow`/`memory_stale` is emitted
with `tool: <action>` and `result: {invalidated: [sorted keys]}` (whenever a rule matched).

**TTL invalidation (`ttl_steps: N`):** at step 3 of every iteration (§5.2), for each TTL rule in
declaration order, the keys with `status = current` and `steps_used − updated_at_step > N` are set
to `0` and marked `stale` (`updated_at_step = steps_used`); if any, one `record`/`allow`/
`memory_stale` with `result: {invalidated: [sorted keys], ttl_steps: N}` is emitted. Evidence
written during step `s` is therefore usable through step `s + N` and a key is reported stale
**once per staleness transition** (a later fresh write re-arms it).

### 8.5 Orientation

When `counterbalance.orientation.emit_each_step` is `true`, each iteration emits
`orient`/`allow` with `observation`:

```json
{
  "permitted_tools": ["<sorted permitted set, §4.1>"],
  "sequence_blockers": [{"action": "...", "missing_prior_tools": ["..."], "missing_prior_any_of": ["..."]}],
  "freshness": {"<key>": 1},
  "completion": {"tool": "...", "require_paths": ["..."], "ready": 0}
}
```

- `sequence_blockers`: sequences (declaration order) with prior-tool requirements that are
  currently unmet; members present only when non-empty; lists sorted.
- `freshness`: every key named by an `invalidate_after` rule ⇒ `1` if its status is `current`,
  else `0`.
- `completion`: present only if `counterbalance.completion` is declared; `require_paths` are the
  sorted unique `path` members of `require`; `ready` is `1` iff `require` holds now.

Nothing else (no tool-name hints, no prose). `orientation` has no other fields.

### 8.6 Output verifies

Message snapshot: `message = {content, contains_code_fence, length}` where `contains_code_fence`
is `1` iff `content` contains "```", and `length` counts code points. For a tool verify, `content`
is `args.message` if it is a string, else `result.message` if a string, else `""`. Agent-level
`counterbalance.output_verifies` run on stop messages (§5.4) with snapshot `{state, message}`;
their events carry no `tool`/`args`/`result`, only `observation: {message}`. In events `content`
is `excerpt(content, max_observation_chars)`.

### 8.7 Intervention budget and triggers

`intervention_budget = {max_activations ≥ 1, window: run | host_day}`. For `window: run`
(default) every iteration that reaches step 4 is one activation (`activations = steps_used`). At
the first iteration where `steps_used > max_activations` the engine emits once
`record`/`allow`/`budget_exceeded` with `result: {max_activations, activations, window: "run"}`.
It is telemetry, never a deny. `window: host_day` is host-persisted; the engine emits nothing.
`triggers` are host declarations; engines do not schedule. Children (§10) inherit neither.

---

## 9. The user channel (D14)

A tool declared `channel: user` is answered by the host's **user channel**: recorded answers in
Track A, a human or a declared simulator live. Its `args` are the question; its output and
transition are the user's answer. **The engine never synthesizes a user-channel answer and a
host MUST NOT answer a user-channel tool from the acting model's arguments.**

- The user channel is *bound* for a tool when the run is in recorded-transcript mode (§15.1) or
  the host supplied a handler for that tool. Hosts MUST supply user-channel handlers only from a
  user-channel binding (deployment form below), never from a world native; a deployment that
  binds a `channel: user` tool to a `native` is an adapter error.
- Unbound ⇒ `validate`/`deny`/`capability_missing`, `failure: {kind: "channel_unbound",
  channel: "user"}` (§6.1 step 4).
- A bound user channel that cannot answer (no matching recorded answer, no interactive human,
  simulator down) is an infrastructure failure (`infra_failure`, `adapter`
  `user_channel_unavailable`), never a synthesized answer.
- User decisions written to state are protected by checkpoint authority (§8.3).

Deployment binding form (host side; implemented by the deployment adapters):

```yaml
bindings:
  user.approve:
    user:
      source: recorded | simulator | human
      answers: <path>              # recorded: JSONL of answers (§15.2), inside the deployment dir
      model: <id>                  # simulator (temperature 0)
      system_prompt_file: <path>   # simulator persona / instructions
      context_file: <path>         # simulator-only context the agent never sees
      profile / base_url / api_key_env / max_tokens   # optional simulator transport overrides
```

A user answer is an envelope `{output, state_transition?}` (recorded) or `{output, set?}`
(simulator / human, `set` ⊆ the tool's `allow_set_keys` with the declared state types); the
engine then applies checkpoint authority (§8.3) like for any tool.

---

## 10. Spawn (`agent.spawn`, D6)

Spawn assigns work to a child reaction; it never mints trust.

**Authorize** (after gates), first failure wins:

1. `spawn.allow` is not `true` (block missing, `{}`, or `false`) ⇒ `gate_denied`,
   `failure: {kind: "spawn", code: "not_allowed"}`.
2. Malformed packet ⇒ `schema_invalid`, `failure: {kind: "spawn", code: "malformed"}`. The packet
   is `args`: `tools` (array of strings, required), optional `filesystem.write_scopes` /
   `read_scopes` (arrays of scopes that normalize, §4.2), optional `limits.max_steps` /
   `max_tool_calls` (integers ≥ 0), optional `spawn_nested` (boolean), `spawn.allow` (boolean),
   `proposals` (array of recorded proposals).
3. Escalation ⇒ `gate_denied`, `failure: {kind: "spawn", code: "escalation", dimension}`:
   `tools` ⊄ parent permitted set; a write scope not covered by a parent write scope (no parent
   write scopes ⇒ every child write scope escalates); a read scope not covered by a parent read
   scope (checked only when the parent declares read scopes); `max_steps` > `max_steps −
   steps_used`; `max_tool_calls` > `max_tool_calls − tool_calls_used − 1` (the spawn call itself
   is charged); nested spawn requested without parent `spawn.allow_nested: true`
   (`dimension: nested`).

**Child.** When the packet has a non-empty `proposals` list, after the parent's `execute`/`allow`
the engine runs a nested reaction with: the parent's committed state (a copy; child writes never
flow back), the parent's declarations filtered to `tools`, the parent's gates, `fallback_state`,
`recovery` and `counterbalance` (without `intervention_budget` / `triggers`), `permissions =
{tools, filesystem: {write_scopes: child ?? parent, read_scopes: child ?? parent}, secrets:
parent, protected_paths: parent}`, `limits = {max_steps: packet ?? remaining steps,
max_tool_calls: packet ?? remaining calls}`, `spawn = {allow: parent.allow_nested === true,
allow_nested: false, tighten_only: true}`, no `mutable`, no judge, the parent's handlers and user
channel for its tools, and the parent's recorded transcript cursor. Child events are appended to
the parent log in order with the parent's `seq` counter, `depth = parent depth + 1` and
`spawn_id = "spawn-<seq of the parent's execute event>"`.

**Charging.** The child's `steps_used` and `tool_calls_used` are added to the parent's. Then the
parent emits `record`/`allow`/`spawn_returned` with `tool: "agent.spawn"` and
`result: {events, steps, tool_calls}` (child counts). A spawn without `proposals` is a stub (only
the tool's own output).

---

## 11. Safe flow and recovery (D10)

The safe flow runs when a gate or verify yields `safe_state` (never from inside a recovery):

1. If `recovery` is declared and `recovery.on` is absent or equals the trigger reason, run the
   **recovery action** `recovery.execute` through the full §6 path with origin `recovery`:
   its `propose` event carries `reason: "recovery_attempt"` (and no verdict); permissions,
   channel binding, gates, sequences, completion, checkpoint authority and limits apply; its
   verify list is the tool's own verifies followed by `recovery.verify`; a `safe_state` verify
   result inside recovery does not start another safe flow; the terminal tool rule (§6.5.3) does
   not apply. The recovery succeeds iff the action's outcome is *success*.
   - success ⇒ `record`/`allow`/`recovery_succeeded`;
   - infrastructure failure (*infra*) ⇒ the run ends right there; nothing further is emitted or
     claimed (no `terminal_failure`, no fallback);
   - otherwise ⇒ `record`/`deny`/`terminal_failure` (the world is **not** claimed safe).
2. Apply `fallback_state` (shallow merge into `state`, if declared) and emit
   `record`/`safe_state`/`safe_state_entered`. This records **bookkeeping only**; it never
   asserts that the physical world is safe.

The run then ends.

---

## 12. Contract tools: mutable cells

`mutable: [skills | memory | instincts]` declares which agent-side cells the agent may edit.
Security (permissions, gates, sequences, checkpoints, tool ids, verifies, schemas, spawn) is
never editable.

| Tool | `args` | Effect after success |
|------|--------|----------------------|
| `harness.propose_skills_patch` | `{ops: [op]}` (exactly one op) | apply; `rebalance`/`allow`/`harness_patch_applied` |
| `harness.decline_skills_patch` | `{reason, note?}` | `record`/`allow`/`harness_patch_declined` |
| `harness.reflect_skills` | `{disposition: "propose", ops}` or `{disposition: "decline", reason, note?}` | as propose / decline |

Ops: `set_tool_description {tool_id, description}` (cell `skills`), `set_memory_note {key, note}`
(cell `memory`; writes `counterbalance.memory_notes[key]`), `set_instinct_text {text}` (cell
`instincts`). Ops `set_permissions_tools`, `set_sequences`, `set_checkpoints`, `set_tool_id`,
`set_tool_verify`, `set_tool_input`, `set_tool_output` are immutable surfaces. Decline reasons:
`no_new_heuristic`, `insufficient_evidence`, `would_overfit_task`, `skills_already_adequate`.

**Authorize checks** (§6.2.3), first failure wins, all with `failure: {kind: "harness_patch", code}`:

| Check | Reason | `code` |
|-------|--------|--------|
| any of the three tools already succeeded in this run (exclusive) | `harness_patch_invalid` | `reflection_done` |
| this tool was already **denied** once in this run (validate input or these checks) | `harness_patch_invalid` | `attempt_cap` |
| `disposition` not `propose`/`decline` (reflect only) | `harness_patch_invalid` | `invalid_disposition` |
| decline reason not in the closed set / note not a string | `harness_patch_invalid` | `invalid_decline` |
| `ops` not an array of exactly one op | `harness_patch_invalid` | `malformed_patch` |
| op not an object with a string `op`, or wrong field types / empty `key` | `harness_patch_invalid` | `malformed_op` |
| op is an immutable surface | `harness_patch_denied` | `immutable_surface` |
| op's cell not in `mutable` | `harness_patch_denied` | `cell_not_mutable` |
| `set_tool_description` names an undeclared tool | `harness_patch_invalid` | `unknown_tool` |
| unknown op | `harness_patch_invalid` | `unknown_op` |

For an op, checks run in the order: malformed_op (object / string `op`), immutable_surface,
unknown_op, cell_not_mutable, field checks (malformed_op / unknown_tool).

The `rebalance` event carries `harness_hash_before` / `harness_hash_after` and
`observation: {ops: 1}` (`reflect`: plus `disposition: "propose"`). The decline record carries
`observation: {reason, note?}` (`reflect`: plus `disposition: "decline"`).

**Harness hash** = SHA-256 hex of the canonical encoding of the current harness IR (declared IR,
normalized, with applied patches) where `state` is the **declared initial state**. Run-time state
and provenance are not part of it.

---

## 13. Events

### 13.1 Fields

JSON Lines, LF, trailing newline, one canonical object per line. Required: `seq` (from 1),
`ts_logical` (= `seq`), `stage`, `state_hash` (of the state when the event is emitted). Optional:
`verdict`, `reason`, `tool`, `args`, `result`, `observation`, `error`, `failure`, `depth`,
`spawn_id`, `harness_hash_before`, `harness_hash_after`. `error` carries only host-originated text
(world feedback, §14), never engine prose.

**Stages (closed):** `orient`, `propose`, `validate`, `authorize`, `execute`, `observe`, `verify`,
`record`, `rebalance`.

**Verdicts (closed):** `allow`, `deny`, `safe_state`. Meaning by stage: at `propose`/`validate`/
`authorize`, `deny` = not executed; at `execute`/`observe`/`verify`, `deny` or `safe_state` =
executed/attempted but rejected (not committed, not successful); at `record`, the verdict
qualifies the recorded fact.

### 13.2 Reason codes (closed)

| Code | Stage · verdict | Meaning |
|------|-----------------|---------|
| `gate_denied` | authorize · deny/safe_state | gate failed; spawn not allowed / escalation (§10) |
| `capability_missing` | validate/authorize · deny | undeclared, not permitted, unbound (world or user channel), observer missing/not permitted |
| `limit_exceeded` | authorize · deny | step or tool-call budget exhausted |
| `input_schema_invalid` | propose/validate · deny | args not canonical / not an object / input schema |
| `output_schema_invalid` | execute/observe · deny | malformed envelope, non-canonical or schema-invalid output |
| `schema_invalid` | validate/authorize · deny | uncompilable tool schema; malformed spawn packet |
| `tool_execution_failed` | execute/observe · deny | transcript mismatch/exhausted, the tool's handler failed |
| `infra_failure` | execute/observe/verify · deny | host infrastructure (adapter) failure; the run ends (§6.3) |
| `state_write_denied` | execute · deny | transition writes an undeclared state key |
| `checkpoint_authority_failed` | authorize/execute · deny | checkpoint authority (§8.3) |
| `sequence_requirement_failed` | authorize · deny | §8.1 |
| `completion_gate_failed` | authorize · deny | §8.2 |
| `verify_effect_failed` | verify · deny/safe_state | §7 |
| `verify_evidence_failed` | verify · deny/safe_state | §7 |
| `verify_absence_failed` | verify · deny/safe_state | §7 |
| `verify_output_failed` | verify · deny/safe_state | §7, §8.6 |
| `verify_judge_invalid` | verify · deny/safe_state | judge unavailable or invalid result |
| `verify_judge_failed` | verify · deny/safe_state | judgment fails `require` |
| `empty_proposal` | propose · deny | the model answered without a tool call (§5.5) |
| `invalid_proposal` | propose · deny | malformed proposal: protocol failure (§5.5) |
| `harness_patch_invalid` | authorize · deny | §12 |
| `harness_patch_denied` | authorize · deny | §12 (immutable surface / cell not mutable) |
| `harness_patch_applied` | rebalance · allow | §12 |
| `harness_patch_declined` | record · allow | §12 |
| `memory_stale` | record · allow | §8.4 |
| `budget_exceeded` | record · allow | §8.7 |
| `run_complete` | record · allow | terminal tool succeeded (§6.5) |
| `spawn_returned` | record · allow | child finished and was charged (§10) |
| `recovery_attempt` | propose · (none) | marks the harness-originated recovery proposal (§11) |
| `recovery_succeeded` | record · allow | §11 |
| `terminal_failure` | record · deny | recovery failed (§11) |
| `safe_state_entered` | record · safe_state | fallback bookkeeping applied (§11) |
| `user_checkpoint_required` | — | reserved; never emitted in 0.3 |

### 13.3 `failure` kinds (closed)

| `kind` | Members | Used with |
|--------|---------|-----------|
| `predicate` | `failed: [{path, current, require, unblock?}]` (v0.2 §4) | completion, sequence `require_state` |
| `missing_prior_tools` | `missing_prior_tools: [sorted]` | sequences |
| `missing_prior_any_of` | `options: [sorted]` | sequences |
| `checkpoint_key` | `checkpoint_key` | `checkpoint_authority_failed` |
| `state_key` | `state_key` | `state_write_denied` |
| `non_canonical` | `path` | `input_schema_invalid`, `output_schema_invalid` |
| `malformed_envelope` | — | `output_schema_invalid` |
| `channel_unbound` | `channel: "world"\|"user"` | `capability_missing` |
| `transcript` | `code: "mismatch"\|"exhausted"`, `call_seq` | `tool_execution_failed` |
| `host_error` | — | `tool_execution_failed` |
| `adapter` | `code` (closed adapter codes, §6.3) | `infra_failure` |
| `observation_failed` | — | `verify_effect_failed` |
| `judge` | `code: "unavailable"\|"invalid"` | `verify_judge_invalid` |
| `spawn` | `code: "not_allowed"\|"escalation"\|"malformed"`, `dimension?` | `gate_denied`, `schema_invalid` |
| `harness_patch` | `code` (§12) | `harness_patch_invalid`, `harness_patch_denied` |

`dimension` ∈ `tools`, `write_scopes`, `read_scopes`, `max_steps`, `max_tool_calls`, `nested`.
In `predicate` items `current` is `null` when the path is MISSING.

---

## 14. World feedback (D13)

Tool outputs (including user-channel answers and observer outputs) and host error messages are
world feedback. After the canonical check (§1.3) and before schema validation and logging, the
engine sanitizes every string **value** in them (object keys are untouched):

1. each declared `permissions.secrets.values` entry (longest first, ties in code point order) is
   replaced by `[redacted]`;
2. the string is replaced by `excerpt(s, limits.max_observation_chars)` (default 8000).

Predicates, schemas and events all see the sanitized output, so the log reflects exactly what
the harness evaluated and what hosts may show the model. Model-authored `args` are logged
verbatim.

---

## 15. Hosts and Track A

### 15.1 Invocation

The engine invokes a tool through, in order of precedence:

1. **Recorded transcript** (`tools.jsonl`, `{call_seq, tool, args, result}`): when the host
   supplies one (even empty) the run is in *recorded-transcript mode* and **every** invocation
   (main, observer, recovery, child) consumes the next entry. `call_seq` must equal the 1-based
   invocation count, `tool` must match, and `args` must be canonically equal; otherwise
   `transcript`/`mismatch`. No entry left ⇒ `transcript`/`exhausted`. Both channels are bound in
   this mode.
2. **Host handler** for the tool id (world channel or user channel).

### 15.2 Recorded user answers

A recorded user source (`user.jsonl` in a fixture, or `answers:` of a `recorded` binding) is a
JSONL file of `{tool, call_seq?, args?, result}` lines, `result` = `{output, state_transition?}`.
For the n-th call of a tool (n = 1-based count of calls to **that** tool), the first unused
answer for the tool whose `call_seq` (if present) equals n and whose `args` (if present) are
canonically equal to the call's args is used, at most once. No such answer ⇒ infrastructure
failure (`infra_failure`, `adapter` `user_channel_unavailable`).

### 15.3 Host conduct

- Hosts offer the model exactly the permitted set (§4.1), each tool as `{id, description,
  input}` from the IR (after applied skills patches).
- **System context (instincts).** Hosts MUST build the model's system message only from
  harness-declared text, exactly: `"You are " + name + "."`, then — each preceded by a blank line
  (`"\n\n"`) and only when present — `instinct_text`, then the applied overlay's `prompt_hint`.
  No host-authored task hints, tool names or policy prose are added, so the agent sees the same
  tokens on every host. `instinct_text` is the instincts cell: harness-authored disposition,
  editable only through `set_instinct_text` when `mutable` includes `instincts` (§12).
- Hosts MAY render prose from `failure` objects for the model; such prose never enters the event
  log.
- A run's success is `record`/`run_complete` — never a bare `execute`/`allow` (D8).
- Infrastructure failures — model transport errors raised to the host and `infra_failure`
  events — are reported apart from model outcomes and excluded from model metrics.
- Host metrics of "caught unsafe actions" count only pre-execution policy denies (`validate` /
  `authorize` with `gate_denied`, `capability_missing` other than `channel_unbound`,
  `sequence_requirement_failed`, `completion_gate_failed`, `checkpoint_authority_failed`,
  `harness_patch_denied`); `memory_stale`, `budget_exceeded` and `tool_execution_failed` are not
  policy denies.

### 15.4 Track A determinism and fixtures

Integers only; canonical JSON; logical clock; declaration-order evaluation; closed codes; no
wall clock, randomness, locale or environment reads; no `judge` verifies in fixtures.

A conformance fixture directory contains `agent.json` (valid IR), `model.jsonl` (recorded
proposals: `{type: "tool", name, args}`, `{type: "stop", message?}`, `{type: "invalid", reason,
message?}`), optional `tools.jsonl` (§15.1), optional `user.jsonl` (§15.2) and `expected.jsonl`.
The replay host uses the reference in-memory world (greenhouse sensors/actuator,
coding files `src/app.ts` = `export {}` and `src/app.js` =
`export function greet(){ return "hello"; }\n`, every declared secret path holding
`sk-fixture-secret-0001`, every protected path present) for world tools, and the recorded user
source for user-channel tools (none ⇒ unbound). An exhausted model stream yields `stop`; the
replay passes no step cap (the harness limits govern).

---

## 16. Migration from v0.1 / v0.2 behaviour

| Topic | Before | Now |
|-------|--------|-----|
| Success | any `execute`/`allow` counted | only verified, committed calls (§6.5) |
| Verify failure | transition kept | transition discarded; `safe_state` always ends the run |
| Checkpoint authority | checked after execution | request at authorize; transition before commit (§8.3) |
| State writes | any key | declared keys only (`state_write_denied`) |
| Spawn | allowed when `spawn` block missing; exempt from `permissions.tools` | denied unless `spawn.allow: true`; permissioned; charged to parent |
| Scopes | string prefix; `src/../../etc` covered by `src` | normalized, segment-wise (§4.2) |
| Recovery | bypassed gates/permissions/limits | full §6 path, marked `recovery_attempt` |
| Orientation | `plan` block, hid `user.approve`, default `task.complete` | generic frame (§8.5), permissions honored |
| Terminal tools | `task.complete` default, `phase.yield` by name | only `completion.tool`; reason `run_complete` (no `phase_yielded`) |
| Verify observation | `shell.run_allowlisted` stdout copy + English hint | world feedback sanitized (§14), no hints |
| TTL | stale at `age ≥ N`, re-emitted each step | stale at `age > N`, once per transition |
| `memory_stale` result | `{invalidated: 1}` / `{invalidated: 1, ttl: 1}` | `{invalidated: [keys]}` / `{invalidated: [keys], ttl_steps: N}` |
| Budget | `steps == max + 1` | first iteration with `steps_used > max_activations` |
| Judge in Track A | crashed the run | `verify_judge_invalid` / `judge` `unavailable` |
| Non-canonical values | crashed when writing the log | rejected at entry (§1.3) |
| Predicates | prototype chain, array `.length` | own JSON-object members only |
| Engine prose (`error`, `hint`) | present | removed; structured `failure` instead |
