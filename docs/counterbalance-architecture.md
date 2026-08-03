# Counterbalance Architecture

**Status:** Design thesis for Fausth (guides v0.2; v0.3 candidates in [`spec-v0.3-draft.md`](spec-v0.3-draft.md)). Normative behaviour remains [`spec-v0.2.md`](spec-v0.2.md) / [`spec-v0.1.md`](spec-v0.1.md) until fixtures promote new semantics.

## Product claim

> Fausth lets developers design and share portable agent harnesses in which agent abilities, awareness, and behaviour are counterbalanced by a programmable world.

Concrete line:

> Give an agent skills, memory, and instincts. Define the gates, user checkpoints, and security that keep them true. Run the same harness locally, in CI, on a server, or in simulation (browser host deferred).

**Lead demo bug:** agents that act on **stale reality** or **skip required sequences** and claim success without proof.

## Two sides, three dimensions

The six cells are **primary counterweights**, not isolated silos (permissions can limit ability; gate evidence updates memory; the user can grant, correct, or redirect).

| Dimension | Agent (soft) | World (hard) | System question |
|-----------|--------------|--------------|-----------------|
| **Ability** | Skills | Gates | Can it attempt this, and what proves it worked? |
| **Awareness** | Memory | User checkpoints | What does it believe, and where can intent/reality correct it? |
| **Behaviour** | Instincts | Security (permissions, hooks, sequences; role harnesses) | What pattern is promoted, and what boundaries enforce a valid path? |

The **model** generates proposals. It is not an architectural axis — transport and model id live in `deployment.yml`.

```text
world presents observations and constraints
        ↓
agent proposes
        ↓
world checks: ability allowed? sequence ok? memory fresh?
        ↓
world executes or refuses (via adapter)
        ↓
world returns evidence / effects
        ↓
memory updates; some memory invalidates
        ↓
loop (or complete / recover)
```

**Instinct** is disposition. The **world** enforces it mid-run against the event log (e.g. deny write before plan approval). Orchestration is the same loop nested — not a separate foundation.

## Control timing (cannot / may not / did not)

The grid names *what*; control timing names *when* a counterweight bites:

| Timing | Name | Epistemics |
|--------|------|------------|
| Design-time | **Cannot** — option absent from the vessel | Auditable offline (YAML tool list) |
| Pre-execution | **May not** — authorize / sequences | Deny before side effects |
| Post-execution | **Did not** — evidence / absence / output verifies | Per-trace proof |

Decision rule: **irreversibility × enumerability** — provision when needs are enumerable; authorize-gate irreversible-but-legitimate actions; absence/output-verify when harms are enumerable on open surfaces. See [`notion-hub/control-timing.md`](notion-hub/control-timing.md).

Mature designs are marked by their **absence** verifies — ask what must *never* happen before what must happen.

## Ability

Distinguish: invocation → result → effect → evidence → absence → **acceptance**.  
v0.1 ships `effect` / `evidence` / `absence`; v0.3 adds `output` verifies for assistant-message surfaces. Counterbalance strengthens acceptance and evidence freshness.

## Awareness

Memory items need provenance and status (`current` | `stale` | `contradicted` | `unknown`). After mutating actions, dependent observations (file snapshots, prior test results) must become stale; evidence also ages by **steps** (`ttl_steps`, v0.3 draft). User checkpoints correct or invalidate beliefs — not only approve.

### Evidence Independence Principle

A checkpoint is only as strong as its **independence** from what it checks. Orchestrator todos written by the *same* model are Gates (`open_todos eq 0`), not User-cell authority. Self-reported learning without observed work is a mirror, not a counterweight.

**`require_prior_tools: [user.approve]` is ordering, not human approval.** If the write harness also provisions `user.approve` (and especially `*_auto` bindings), the model can satisfy the sequence itself. Prefer a **plan/impl pipeline** (implementation omits `user.approve`; host starts write phase only after plan-phase approve) — see coding-counterbalance and adversarial CB.

**Secrets** are declared under `permissions.secrets` (`paths` / `values`, `deny_write_contains`). The engine refuses `fs.write_scoped` when content contains a registered secret (`secret_leak: 1`). Path scopes alone cannot protect in-scope exfil.

**Protected paths** (`permissions.protected_paths`) enforce **absence of change**: baseline content is snapshotted at world init; direct writes are denied (`protected_modified: 1`); shell mutations that drift the hash are rolled back and flagged. Prefer this over parsing tool-call text.

## Behaviour

Role-specific **subagent harnesses** (separate YAMLs with distinct tool lists), permissions, sequence requirements, and hooks shape acceptable paths. Same exchange kernel for coding, support, CI review, later multi-agent. Do not multiplex roles via in-YAML modes.

## Host as part of the vessel

Host scheduling, triggers, and cross-run memory are policy. Leaving them outside the harness recreates “modes smuggled into the host.” Intervention budgets and declarative triggers (v0.3 draft) pull activation rate back into the counterbalance. Deny logs are sensors — see [`notion-hub/deny-log-as-sensor.md`](notion-hub/deny-log-as-sensor.md).

## Reference harnesses

1. **Coding** — research/plan/implementation subagents, plan approval, scoped writes, invalidate-on-edit, tests, completion gates.  
2. **Support bot** — KB evidence before policy, handoff, user-corrected context.  
3. **SLOPATHON reviewer** — CI host proof; evidence-bound findings; human merge authority.

## Fixture discipline

Every new semantic starts from a **failing Track A fixture**. Schema fields that exist only for diagram symmetry are rejected.

See also: [`glossary.md`](glossary.md) · [`spec-v0.2.md`](spec-v0.2.md) · [`BASELINE-v0.1.md`](BASELINE-v0.1.md).
