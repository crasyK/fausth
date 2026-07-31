# Self-improving harnesses (design)

**Status:** Design only — **not** implemented in Fausth `0.3.0-alpha`.  
**Audience:** Harness engineers considering mutation + selection over Counterbalance cells.

## Claim

Most “self-improving agents” today only rewrite memory. In Counterbalance, the harness is a **single declarative contract**. That file (or its canonical IR) can be the mutation surface — but only for cells that are safe to evolve.

## Mutable vs immutable cells

| Cell | Mutable? | Why |
|------|----------|-----|
| Skills | Yes (candidate) | Expand how-to knowledge, tool tips, search heuristics |
| Memory schema / instincts text | Maybe | High risk of silent drift; prefer versioned slots |
| Gates / verifies | Careful | Changing proof rules changes the fitness landscape |
| Security (permissions, sequences, scopes) | **Never by the agent** | The world counterweight must not rewrite itself |
| User checkpoints | Never by the agent | Independence principle |

Sketch (non-normative):

```yaml
mutable: [skills]
# security omitted ⇒ immutable by contract
```

## Fitness and reproduction

1. **Mutation** — agent (or offline optimizer) proposes a skills-only patch to `agent.yml`.
2. **Selection** — host re-runs Track A fixtures (`fausth replay` / conformance). Any golden failure rejects the mutation.
3. **Reproduction** — accepted harnesses are `fausth pack`’d; optional Ed25519 signature binds integrity. Unsigned forks are allowed for private experiments; published forks SHOULD be signed.

## Why deferred

- Needs output verifies, memory provenance, and deny audit (M12–M14) so mutations are measurable.
- Needs a clear IR diff + allowlist for which JSON paths may change.
- Premature engine support would invite agents to weaken security under the banner of “improvement.”

## Relation

- Deny log as sensor · Control timing · [`spec-v0.3-draft.md`](spec-v0.3-draft.md) Appendix A
- Talk beat: self-learning — mutation + selection (25-min outline)
