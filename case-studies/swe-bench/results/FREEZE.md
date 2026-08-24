# Track S freeze

**Status:** FROZEN (documentation closure) · **Date:** 2026-08-04

Track S (SWE-bench Lite HRI, fixed `kit.gemma4-31b-it`) is closed for this cycle without further open-ended optimization.

## What we concluded

1. **Pipeline unblocked:** plan → implementation engages on most opt-arms attempts after Phase 0.
2. **Measurement fixed:** v3 grading produces numeric `grade_exit_code` and non-empty diffs when edits occur.
3. **Levers shipped:** plan-path enforcement + stderr on test verify deny.
4. **Utility zero:** all measured arms remain 0% `task_success` / `ground_truth_pass`.

## Valid bounded claim

> On fixed Gemma, harness work unblocked plan-to-implementation and improved grading/observability, but did not produce holdout SWE task success on measured arms.

## Do not claim

- Specialization lift, SWE leaderboard delta, or “mutable arm failed as an idea.”

## Artifacts

- [`claim.yml`](claim.yml)
- [`residuals.json`](residuals.json)
- [`PROVENANCE.md`](PROVENANCE.md)
- Narrative: [`HRI-S-STATUS-REPORT.md`](HRI-S-STATUS-REPORT.md), [`HRI-S-IN-IMPL-REPORT.md`](HRI-S-IN-IMPL-REPORT.md)

## Reopen trigger

1. Chess procedural stability gate passes ([`../chess/results/PROCEDURAL-RELIABILITY.md`](../chess/results/PROCEDURAL-RELIABILITY.md)).
2. A new lever is written down (not another unbounded matrix).
3. Evidence pack validator passes on updated `claim.yml`.

## Next agent

```bash
node scripts/validate-evidence.mjs case-studies/swe-bench/results
cat case-studies/swe-bench/results/claim.yml
```

Do **not** launch new Gemma SWE matrices without a pre-registered lever and frozen claim update.
