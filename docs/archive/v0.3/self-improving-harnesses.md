# Self-improving harnesses

**Status:** Implemented in Fausth engines (M16) — Track A fixtures `cb-harness-patch-*`.  
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

```yaml
mutable: [skills]
# security omitted ⇒ immutable by contract
```

On v0.1 IR, **skills** map to tool `description` fields only — never `id`, `input`/`output` schemas, or `verify`.

## Fitness and reproduction

1. **Mutation** — agent proposes a skills-only patch via `harness.propose_skills_patch` (`ops: [...]`).
2. **Selection** — host runs `fausth select <harness> --candidate-patch <patch.json>` (re-runs Track A fixtures). Any golden failure rejects the mutation.
3. **Reproduction** — accepted harnesses are `fausth pack`’d; optional Ed25519 signature binds integrity. Unsigned forks are allowed for private experiments; published forks SHOULD be signed.

## Runtime surface

- Tool: `harness.propose_skills_patch`
- Decline: `harness.decline_skills_patch` / unified `harness.reflect_skills` (`disposition` + reason enum + optional `note`) with sequences for end-of-phase reflection
- Stage: `rebalance` (emits `harness_hash_before` / `harness_hash_after`)
- Reason codes: `harness_patch_applied`, `harness_patch_denied`, `harness_patch_invalid`, `harness_patch_declined`
- Example: [`examples/mutable-skills/`](../examples/mutable-skills/); coding fork: [`examples/coding-mutable-skills/`](../examples/coding-mutable-skills/)
- Case study: [`case-studies/mutable-cells/`](../case-studies/mutable-cells/)
- Fixtures: `cb-harness-patch-skills-ok`, `cb-harness-patch-security-denied`, `cb-harness-patch-memory-cautious`, `cb-decline-skills-ok`, `cb-reflect-before-yield-denied`

## Relation

- Deny log as sensor · Control timing · [`spec-v0.3-draft.md`](spec-v0.3-draft.md) Appendix A
- Talk beat: self-learning — mutation + selection (25-min outline)
