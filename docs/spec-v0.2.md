# Counterbalance Contract — Specification v0.2

**Status:** Normative for Faust Harness `0.2.0-alpha`  
**Spec id:** `counterbalance-contract/v0.2`

This document extends [`spec-v0.1.md`](spec-v0.1.md). Where they conflict on Counterbalance bridge fields, event optional fields, or CB reason codes, **this document wins**. Track A goldens for CB fixtures MUST be hand-derived from this prose. Live model runs MUST NOT rewrite golden expectations automatically.

Companion: [`counterbalance-architecture.md`](counterbalance-architecture.md) · [`glossary.md`](glossary.md) · schema [`../schema/counterbalance-contract.v0.2.json`](../schema/counterbalance-contract.v0.2.json).

---

## 1. Design direction (authoring shape)

```yaml
spec: counterbalance-contract/v0.2
name: example-harness

agent:
  skills: []       # was tools[]
  memory: []       # slots with provenance metadata
  instincts: []    # disposition; world enforces via security

world:
  gates: []
  user: {}
  security:
    permissions: {}
    hooks: []
    sequences: []      # require prior tools / state before action
    invalidate_after: []  # after action, mark memory keys stale

exchange:
  completion: {}
  recovery: {}

limits: {}
```

Role multiplexing uses **separate harness YAMLs** (host-loaded subagents), not an in-YAML modes register.

Engines MUST accept v0.1 `agent.yml` and the executable bridge in §2. Full v0.2 authoring shape above is the target; the bridge remains valid IR.

## 2. Executable bridge on v0.1 IR

Additive on v0.1 `AgentIR` / `agent.json`:

```yaml
# Inside agent.yml / agent.json (v0.1 IR + extensions)
counterbalance:
  sequences:
    - id: plan-before-write
      action: fs.write_scoped
      require_prior_tools: [user.approve]
  invalidate_after:
    - action: fs.write_scoped
      memory_keys: [test_evidence_current, file_observation_current]
  completion:
    tool: task.complete
    require:
      all:
        - { path: state.test_evidence_current, eq: 1 }
        - { path: state.open_todos, eq: 0 }
  checkpoints:
    - tool: user.correct
      allow_set_keys: [open_todos]
  orientation:
    emit_each_step: true
```

### Semantics

1. **Capability surface:** The harness `tools:` / `permissions.tools` list is the only tool schema offered to the model. Tools not declared → `capability_missing`. Do not use in-YAML modes.
2. **Sequences:** Before execute, if a sequence matches `action`, require prior successful execute of each `require_prior_tools` entry in the event log, and/or `require_state` predicate. Failure → `sequence_requirement_failed` with structured `failure` (§4).
3. **Invalidate after:** After a successful execute (+ verifies allow) of `action`, set each `memory_keys` entry in `state` to `0` and emit `record` with reason `memory_stale`.
4. **Completion:** `task.complete` (or configured tool) requires `completion.require` against snapshot state. Failure → `completion_gate_failed` with structured `failure` (§4).
5. **Checkpoints:** Tools listed under `checkpoints` may only set keys in `allow_set_keys`. Violation → `checkpoint_authority_failed` with structured `failure` (§4).

## 3. Reason codes (Counterbalance)

In addition to the closed v0.1 reason codes in [`spec-v0.1.md`](spec-v0.1.md) §7, engines that implement the Counterbalance bridge MUST emit these when applicable:

| Code | When |
|------|------|
| `capability_missing` | Tool not declared on this harness (or observer not permitted) |
| `sequence_requirement_failed` | Prior tool/state sequence not satisfied |
| `memory_stale` | Recorded invalidation of memory keys |
| `completion_gate_failed` | Completion proposal failed state evidence |
| `checkpoint_authority_failed` | Checkpoint tool attempted a protected state key |
| `user_checkpoint_required` | Reserved for later hooks |
| `empty_proposal` | Model stopped/invalid with no tool call after retry |

Event stages remain v0.1 stages; invalidation uses `record` + `memory_stale`.

## 4. Structured deny signal (`failure`)

Counterbalance denies with reason `completion_gate_failed`, `sequence_requirement_failed`, or `checkpoint_authority_failed` MUST include a machine-checkable `failure` object on the deny event. The engine derives structure from predicate evaluation and declared checkpoints — no free-text remediation in the event log.

### Closed `failure.kind`

| `kind` | When | Payload |
|--------|------|---------|
| `predicate` | Completion or sequence `require_state` failed | `failed[]` with `path`, `current`, `require` |
| `missing_prior_tools` | Sequence prior tools not yet executed | `missing_prior_tools[]` (sorted) |
| `checkpoint_key` | Checkpoint tool attempted a protected state key | `checkpoint_key` |

### `failed[]` items (`kind: predicate`)

Each entry:

- `path` — predicate path (e.g. `state.open_todos`)
- `current` — value at that path, or `null` if missing
- `require` — leaf constraint object (`eq`, `neq`, `eq_path`, `lt`, `lte`, `gt`, or `gte`)
- `unblock` (optional) — only when a declared checkpoint’s `allow_set_keys` covers the state key **and** the failing leaf uses `eq`:

```json
"unblock": { "tool": "user.correct", "set_key": "open_todos", "set_value": 0 }
```

Absent checkpoint coverage or non-`eq` leaves → omit `unblock`.

### Host prose

Live conversational hosts MAY render prose from `failure` for model-facing tool results. Conformance fixtures and event logs MUST use the structured object only. Ad-hoc `hint` strings on deny events are forbidden.

## 5. Event log (v0.2 extension)

v0.1 event requirements in [`spec-v0.1.md`](spec-v0.1.md) §8 still apply.

Optional fields (v0.2): `verdict`, `reason`, `tool`, `args`, `result`, `observation`, `error`, **`failure`**.

`failure` MUST appear on Counterbalance denies listed in §4.

## 6. Ability / awareness / behaviour (fixture map)

| Axis | Fixtures |
|------|----------|
| Ability | missing evidence, binding missing (existing verify-*) |
| Awareness | `cb-stale-test-success`, edit invalidates test evidence |
| Behaviour | `cb-write-before-plan-denied`, `cb-completion-open-todos-denied`, `cb-user-correction-cannot-be-self-authored` |

## 7. Normalization map (v0.1 → v0.2 concepts)

| v0.1 | v0.2 reading |
|------|----------------|
| `tools` | `agent.skills` |
| `gates` / tool `verify` | `world.gates` |
| `state` | memory values (provenance via `counterbalance` / future `agent.memory`) |
| `permissions` | `world.security.permissions` |
| `safe_state` / `fallback_state` | recovery |
| `spawn` | nested reaction policy |
| `limits` | exchange / world limits |
