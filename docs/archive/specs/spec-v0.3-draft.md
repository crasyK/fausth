# Counterbalance Contract — v0.3 candidates (draft)

**Status:** Draft. The executable contract is **normative** in [`spec-v0.3.md`](spec-v0.3.md):
output verifies, memory provenance and `ttl_steps`, intervention budgets, mutable cells, the user
channel, declared effects, closed reason codes and failure kinds are specified there and covered by
Track A fixtures. This page keeps only what is **not** executable yet.

Companion: [`counterbalance-architecture.md`](counterbalance-architecture.md) ·
[`glossary.md`](glossary.md) · [`self-improving-harnesses.md`](self-improving-harnesses.md).

---

## A. The agent / world / exchange authoring shape (not loadable)

[`spec-v0.2.md`](spec-v0.2.md) §1 sketches the Counterbalance shape — agent cells (skills, memory,
instincts) opposite world cells (gates, user, security) and an exchange. It is the design
direction, but **no engine loads it in 0.3**: documents with top-level `agent` / `world` /
`exchange` fail validation, and [`../schema/counterbalance-contract.v0.2.json`](../schema/counterbalance-contract.v0.2.json)
is marked `x-status: draft-not-loadable`.

Planned translation to the executable IR (each field maps 1:1; anything without executable
meaning is rejected rather than ignored — "schema fields that exist only for diagram symmetry
are rejected"):

| Authoring shape | Executable IR |
|-----------------|---------------|
| `agent.skills[]` | `tools[]` (world-channel tools) |
| `agent.memory` (key → initial value, provenance) | `state`, `counterbalance.memory_provenance`, `invalidate_after` |
| `agent.instincts` (text) | `instinct_text` |
| `world.gates[]` | `gates[]` and tool `verify` |
| `world.user.tools[]` / `checkpoints[]` | `tools[]` with `channel: user` · `counterbalance.checkpoints` |
| `world.security.permissions` / `sequences` / `spawn` | `permissions` / `counterbalance.sequences` / `spawn` |
| `exchange.completion` / `recovery` / `fallback_state` / `orientation` | `counterbalance.completion` / `recovery` / `fallback_state` / `counterbalance.orientation` |
| `limits` | `limits` |

Open: `world.security.hooks`, `world.user.can_interrupt`, memory `authority` / `correction` have
no executable semantics yet and would be rejected until specified.

## B. Host-persisted budgets and triggers

`intervention_budget.window: host_day` and `triggers` are declarations the engine does not act on
(spec-v0.3 §8.7). A host protocol for passing persisted activation counts into a run is open.

## C. `user_checkpoint_required`

Reserved reason code (never emitted). Candidate: a declared hook that requires a user-channel call
before a named action, emitted as an authorize deny.
