# SWE-bench Lite HRI results

> **RETRACTED (2026-10-13) — invalid measurement, not a negative result.** Every task_success /
> ground_truth_pass number in this document was produced by a grader that never applied the gold
> `test_patch`, ran FAIL_TO_PASS ids through Fausth's own `.venv` pytest without the repository
> installed (`ModuleNotFoundError: django`), used Django/SymPy ids that are not pytest node ids, and
> hardcoded `test_tampering=false` (audit SCR-1/CASE-1). A 0% was structurally guaranteed. The
> numbers below are kept only as **invalid, superseded** history. Current grader + self-test:
> [`../GRADER-VALIDATION.md`](../GRADER-VALIDATION.md); status of every claim:
> [`../../CLAIMS-STATUS.md`](../../CLAIMS-STATUS.md).


| Run id | Mode | Scope | Notes |
|--------|------|-------|-------|
| `hri-swe-recorded-smoke` | recorded | 1 task × 2 arms | Plumbing only |
| `hri-swe-smoke-v1` | live KIT gemma | `pallets__flask-4045` × CB+PC | Path proven |
| `hri-swe-v1-l1-gemma` | live KIT gemma | 3 tasks × 2 arms × 1 rep (**frozen for HRI**) | 6/6 scored; task_success 0/6 (unsolved Lite) |

Full 25-instance × 2-model matrix: launch with
`node scripts/kit-tmux-shard.mjs launch --level 2 --manifest case-studies/swe-bench/manifest.yml --run-id-prefix hri-swe-full --reps 1`.

Not a SWE-bench leaderboard score — Fausth CB vs PC only.
