# Counterbalance Contract — Specification v0.3 (draft)

**Status:** Draft — normative candidates for Faust Harness `0.3.0-alpha`  
**Spec id:** `counterbalance-contract/v0.3` (candidates); engines MAY promote sections behind Track A fixtures.

This document extends [`spec-v0.2.md`](spec-v0.2.md). Normative promotion requires failing fixtures first, then TS + Python parity.

Companion: [`counterbalance-architecture.md`](counterbalance-architecture.md) · [`glossary.md`](glossary.md) · schema [`../schema/counterbalance-contract.v0.3.draft.json`](../schema/counterbalance-contract.v0.3.draft.json) · [`self-improving-harnesses.md`](self-improving-harnesses.md).

---

## 1. Output-surface verifies (`kind: output`)

### Intent

Conversational harm often walks through **assistant messages**, not tool results. Capability absence closes tool doors; output verifies close the chat door (“did not”).

### Shape

```yaml
# On a tool that carries a message (e.g. teacher.reply), or agent-level:
verify:
  - kind: output
    require:
      path: message.contains_code_fence
      eq: 0
    otherwise: deny
```

Agent-level (evaluated on `stop` proposals that include a message):

```yaml
counterbalance:
  output_verifies:
    - kind: output
      require: { path: message.contains_code_fence, eq: 0 }
      otherwise: deny
```

### Snapshot

Engines MUST bind:

| Path | Meaning |
|------|---------|
| `message.content` | UTF-8 string of the assistant / tool message |
| `message.contains_code_fence` | Integer `1` if content matches a fenced code block (` ``` `), else `0` |
| `message.length` | Integer character length (portable int53) |

For tool-attached `kind: output`, `message.content` defaults to `action.args.message` if present, else `result.message`.

### Reason code

Failure → `verify_output_failed`. Track A compatible (no judge required). Live-only `judge` remains available for semantic rubrics.

### Control timing

This is **did not** (post-execution / post-proposal). Prefer **cannot** when the option itself must never exist.

---

## 2. Memory provenance and time-based invalidation

### Intent

Memory without provenance goes stale silently (lead demo bug). Mutation-triggered `invalidate_after` (v0.2) is necessary but not sufficient — evidence also ages by **steps**.

### Memory slots (opt-in)

Plain `state` maps remain valid. Optional provenance metadata:

```yaml
# Conceptual / future authoring shape
agent:
  memory:
    - id: test_evidence_current
      status: current   # current | stale | contradicted | unknown
      updated_at_step: 0
      source: world     # user | world | agent-inference
```

Executable bridge (v0.1 IR + extensions) — engines MAY store provenance beside state:

```yaml
counterbalance:
  memory_provenance:
    test_evidence_current:
      status: current
      source: world
  invalidate_after:
    - action: fs.write_scoped
      memory_keys: [test_evidence_current]
    - ttl_steps: 3
      memory_keys: [test_evidence_current]
```

### `ttl_steps` semantics

When an `invalidate_after` entry has `ttl_steps: N` (positive integer) and lists `memory_keys`:

1. On each successful state write to a listed key (or when the key is set to a “fresh” truthy value such as `1`), record `updated_at_step = current steps_used`.
2. Before propose on each loop iteration, if `steps_used - updated_at_step >= N`, set each listed key to `0` (or slot `status: stale`) and emit `record` with reason `memory_stale`.
3. Entries with `action:` keep v0.2 mutation semantics. An entry MAY have `action` XOR `ttl_steps` (not both in v0.3 draft).

v0.2 plain integer state keys remain the Track A surface; provenance maps are additive.

---

## 3. Intervention budgets and triggers

### Intent

Host-side timers and cron loops are policy. Leaving them outside the contract recreates “modes smuggled into the host.” Budgets pull activation rate back into the vessel.

### Shape

```yaml
counterbalance:
  intervention_budget:
    max_activations: 5
    window: run          # run | host_day (host-persisted)
  triggers:
    - id: periodic_scan
      kind: cron         # cron | event | human
      every_seconds: 60  # host interprets
```

### Semantics

- **Engine-visible:** When the host reports an activation count ≥ `max_activations` for `window: run`, the engine emits a `record` event with reason `budget_exceeded` and MUST NOT treat it as a harness `deny` (keeps Track A goldens free of host scheduling). Further proposals in that run MAY be refused by the host before `propose`.
- **Host-persisted:** `window: host_day` counters live outside the engine; hosts SHOULD persist and pass the count in.
- Triggers are **declarations**; engines do not schedule. Hosts MUST honor them or document non-conformance.

### Reason code

`budget_exceeded` — recorded on `record` stage, verdict omitted or `allow` with reason for telemetry.

---

## Appendix A — Mutable cells (non-normative)

Self-improving harnesses MAY declare which Counterbalance cells are editable:

```yaml
# Non-normative sketch
mutable: [skills]          # agent may propose harness edits here
# security: always immutable by contract
```

Fitness function: re-run Track A fixtures after mutation. Reproduction boundary: `fausth pack` + optional Ed25519 signature.

Deferred from `0.3.0-alpha` engines. See [`self-improving-harnesses.md`](self-improving-harnesses.md).

---

## Reason codes (additions)

| Code | Stage | Notes |
|------|-------|-------|
| `verify_output_failed` | verify | Output-surface verify |
| `budget_exceeded` | record | Intervention budget (host/engine telemetry) |

Existing codes from v0.1 / v0.2 remain closed and unchanged.
