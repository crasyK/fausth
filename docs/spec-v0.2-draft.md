# Counterbalance Contract — Specification draft v0.2

**Status:** Non-normative design draft. Normative behaviour remains [`spec-v0.1.md`](spec-v0.1.md) until Track A fixtures promote fields.  
**Spec id (proposed):** `counterbalance-contract/v0.2`

Companion: [`counterbalance-architecture.md`](counterbalance-architecture.md) · [`glossary.md`](glossary.md) · schema draft [`../schema/counterbalance-contract.v0.2.draft.json`](../schema/counterbalance-contract.v0.2.draft.json).

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
    modes: []
    hooks: []
    sequences: []      # require prior tools / state before action
    invalidate_after: []  # after action, mark memory keys stale

exchange:
  completion: {}
  recovery: {}

limits: {}
```

During migration, engines MAY accept v0.1 `agent.yml` and normalize internally. Optional v0.1 extension keys used by the coding vertical slice (documented below) are the **executable bridge** before full v0.2 authoring is required.

## 2. v0.1 extension keys (executable now)

Additive on v0.1 `AgentIR` / `agent.json` (ignored by older validators if `additionalProperties` — schema v0.1 is closed, so these live under a single optional bag):

```yaml
# Inside agent.yml / agent.json (v0.1 IR + extensions)
counterbalance:
  mode: research                    # current mode id (also mirrored in state.mode)
  modes:
    - id: research
      tools: [fs.read, mode.enter, user.correct]
    - id: plan
      tools: [fs.read, user.approve, mode.enter, user.correct]
    - id: implementation
      tools: [fs.read, fs.write_scoped, shell.run_allowlisted, mode.enter, task.complete, user.correct]
  sequences:
    - id: plan-before-write
      action: fs.write_scoped
      require_prior_tools: [user.approve]
    - id: research-before-plan-approve
      action: user.approve
      require_state:
        path: state.researched
        eq: 1
  invalidate_after:
    - action: fs.write_scoped
      memory_keys: [test_evidence_current, file_observation_current]
  completion:
    tool: task.complete
    require:
      all:
        - { path: state.test_evidence_current, eq: 1 }
        - { path: state.open_todos, eq: 0 }
```

### Semantics

1. **Mode tools filter:** If `counterbalance.modes` is present, authorize denies tools not listed for `state.mode` (or `counterbalance.mode`) with reason `mode_denied`.
2. **Sequences:** Before execute, if a sequence matches `action`, require either prior successful execute of each `require_prior_tools` entry in the event log, and/or `require_state` predicate. Failure → `sequence_requirement_failed`.
3. **Invalidate after:** After a successful execute (+ verifies allow) of `action`, set each `memory_keys` entry in `state` to `0` and emit `record` with reason `memory_stale` (informational) or a dedicated stage note in `error`/`result`. Prefer setting state integers to `0` and emitting stage `record` with reason `memory_stale`.
4. **Completion:** `task.complete` (or configured tool) runs evidence verifies from `completion.require` against snapshot state.

## 3. Event / reason proposals

New reason codes (only when fixtures emit them):

| Code | When |
|------|------|
| `mode_denied` | Tool not allowed in current mode |
| `sequence_requirement_failed` | Prior tool/state sequence not satisfied |
| `memory_stale` | Recorded invalidation of memory keys (and/or deny citing stale evidence) |
| `completion_gate_failed` | Completion proposal failed state evidence |
| `user_checkpoint_required` | Reserved for later hooks |

Event stage remains v0.1 stages; invalidation uses `record` + `memory_stale`. Future event families (`observation.invalidated`, …) may alias these without breaking goldens.

## 4. Ability / awareness / behaviour (fixture map)

| Axis | Planned fixtures |
|------|------------------|
| Ability | missing evidence, binding missing (existing verify-*) |
| Awareness | `cb-stale-test-success`, edit invalidates test evidence |
| Behaviour | `cb-write-before-plan-denied`, `cb-completion-open-todos-denied` |

## 5. Normalization map (v0.1 → v0.2 concepts)

| v0.1 | v0.2 reading |
|------|----------------|
| `tools` | `agent.skills` |
| `gates` / tool `verify` | `world.gates` |
| `state` | memory values (provenance via `counterbalance` / future `agent.memory`) |
| `permissions` | `world.security.permissions` |
| `safe_state` / `fallback_state` | recovery |
| `spawn` | nested reaction policy |
| `limits` | exchange / world limits |
