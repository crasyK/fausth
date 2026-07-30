# Counterbalance Architecture

**Status:** Design thesis for Fausth (guides v0.2). Normative behaviour remains [`spec-v0.1.md`](spec-v0.1.md) until fixtures promote new semantics.

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

## Ability

Distinguish: invocation → result → effect → evidence → absence → **acceptance**.  
v0.1 already ships `effect` / `evidence` / `absence` verifies; Counterbalance strengthens acceptance and evidence freshness.

## Awareness

Memory items need provenance and status (`current` | `stale` | `contradicted` | `unknown`). After mutating actions, dependent observations (file snapshots, prior test results) must become stale. User checkpoints correct or invalidate beliefs — not only approve.

## Behaviour

Role-specific **subagent harnesses** (separate YAMLs with distinct tool lists), permissions, sequence requirements, and hooks shape acceptable paths. Same exchange kernel for coding, support, CI review, later multi-agent. Do not multiplex roles via in-YAML modes.

## Reference harnesses

1. **Coding** — research/plan/implementation subagents, plan approval, scoped writes, invalidate-on-edit, tests, completion gates.  
2. **Support bot** — KB evidence before policy, handoff, user-corrected context.  
3. **SLOPATHON reviewer** — CI host proof; evidence-bound findings; human merge authority.

## Fixture discipline

Every new semantic starts from a **failing Track A fixture**. Schema fields that exist only for diagram symmetry are rejected.

See also: [`glossary.md`](glossary.md) · [`spec-v0.2.md`](spec-v0.2.md) · [`BASELINE-v0.1.md`](BASELINE-v0.1.md).
