# Notion hub update patches (Phase 0)

> Apply via Notion MCP when available. Local copies capture the intended edits.

## Counterbalance Architecture — additions

### Evidence Independence Principle (under Awareness / User)

A checkpoint is only as strong as its **independence** from the thing it checks.

- Orchestrator-written todos from the *same* model are **Gates** (`open_todos eq 0`), not User-cell checkpoints.
- Self-reported learning (“did you understand?”) has no independence — prefer evidence from user-produced work (edits, answers under observation).
- Correlated failure: when checker and checked share the same inference process, the counterweight collapses into a mirror.

### Host-in-vessel note

Host scheduling, triggers, and cross-run memory are part of the **reaction vessel**. Today they are the least counterbalanced component — policy often lives outside the harness YAML (“host-side scheduling is the new modes”). Fausth v0.3 candidates: intervention budgets + declarative triggers (M15), long-term memory provenance (M13).

## Counterbalance field guide — additions

Per-cell control-timing annotation:

| Cell | Cannot | May not | Did not |
|------|--------|---------|---------|
| Skills / Gates | Tool not listed | Authorize / sequence | evidence / absence / output |
| Memory / User | N/A (beliefs) | Checkpoint authority | Provenance / stale status |
| Instincts / Security | Role YAML tool list | Sequences / permissions | Absence of forbidden patterns |

Footer heuristic (keep):

> Ask before adding anything: What did I disturb? What counterbalances it?

Add:

> Mature designs are marked by their absence verifies — ask what must *never* happen before what must happen.

## Faust Harness (project status) — v0.3 shipped

**v0.3.0-alpha shipped** — M12 output verifies, M13 memory TTL/provenance, M14 `fausth audit`, M15 intervention budgets + triggers.
Mutable cells remain design-only (`docs/self-improving-harnesses.md`).
Local theory drafts for Notion publish: `docs/notion-hub/`.

Tag when published: `v0.3.0-alpha`
