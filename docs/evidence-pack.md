# Evidence pack convention (v0.1)

Minimum artifacts for a **bounded, auditable** case-study claim. Another agent should reproduce or reject the claim from these files alone.

## Per-study layout

```
case-studies/<study>/
  README.md           # what this study is
  RUNBOOK.md          # how to reproduce (optional until live runs)
  results/
    claim.yml         # bounded claim + exclusions
    residuals.json    # known failures, infra holes, open questions
    PROVENANCE.md     # hashes, run ids, commit, independence notes
    *.summary.json    # machine aggregates (optional)
    *-REPORT.md       # human narrative (optional)
```

## claim.yml fields

| Field | Required | Description |
|-------|----------|-------------|
| `study_id` | yes | Stable study identifier |
| `claimed` | yes | List of bounded positive claims |
| `not_claimed` | yes | Explicit exclusions |
| `model` | if live | Model id(s) and deployment |
| `population` | yes | Tasks/episodes and conditions |
| `evaluation_matrix` | yes | Arms, reps, holdouts |
| `hashes` | yes | harness, deployment, result digests |
| `independence` | yes | What evidence actor cannot self-provision |
| `outcome` | yes | `positive` \| `negative` \| `inconclusive` |
| `recorded_vs_live` | yes | Which artifacts are plumbing-only |

## residuals.json

Required when `task_success` is 0 or partial. List:

- failure modes with counts or examples
- infra failures (excluded from scored denominator)
- accepted limitations
- reopen triggers

## Validator

```bash
pnpm evidence:check
# or
node scripts/validate-evidence.mjs case-studies/swe-bench/results
```

Checks (minimal wall):

1. `claim.yml` present and parseable
2. `not_claimed` non-empty for negative/inconclusive outcomes
3. `hashes` object present
4. `residuals.json` present when outcome is negative or inconclusive
5. Recorded fixtures not counted as live observations in claim text
6. Mutation claims declare holdout splits (if `mutable` mentioned in claimed)

## Examples

- Track S freeze: [`case-studies/swe-bench/results/`](../case-studies/swe-bench/results/)

## Not in scope (v0.1)

- Full HarnessC compiler / SOP → contract frontend
- Automatic holdout contamination detection
- Cost-per-success aggregation (manual in summary JSON for now)
