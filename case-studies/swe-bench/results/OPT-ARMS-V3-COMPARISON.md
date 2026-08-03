# Track S opt-arms v2 vs v3 — final comparison

**Report:** [`HRI-S-IN-IMPL-REPORT.md`](HRI-S-IN-IMPL-REPORT.md)

## Pipeline fixes in v3

- `scripts/pytest-runner.sh` + venv activation in `opt-arms-tmux.mjs`
- `gradeSweBench`: `.venv/bin/pytest`, `grade.details`, mirror-based `worktree.diff`
- Lever 1: plan-path write enforcement (warn → deny)
- Lever 2: stdout/stderr on `verify_evidence_failed`

## task_success_any_of

| Arm | v2 | v3 | Δ |
|-----|----|----|---|
| baseline | 0/7 (0.0%) | 0/8 (0.0%) | 0 pp |
| budget | 0/8 (0.0%) | 0/7 (0.0%)† | 0 pp |
| mutable | 0/8 (0.0%) | partial‡ | — |
| optimize | — | partial‡ | — |

† budget missing django (infra failure).  
‡ mutable/optimize killed at task 5/8; 22 scored tries each, 0 successes.

## Grading pipeline (scored attempts)

| Arm | v2 `grade_exit_code` null | v3 numeric | v3 non-empty diff |
|-----|---------------------------|------------|-------------------|
| budget | 8/8 | 7/7 | 3/7 |
| baseline | (v2: 0/7 null) | 8/8 | 4/8 |

**v3 utility unchanged; measurement fixed.**

## Run status

| Run ID | Status |
|--------|--------|
| `hri-swe-opt-arms-v3-baseline` | Complete (8/8) |
| `hri-swe-opt-arms-v3-budget` | Complete (7/8) |
| `hri-swe-opt-arms-v3-mutable` | Partial — killed |
| `hri-swe-opt-arms-v3-optimize` | Partial — killed |

```bash
node scripts/compare-opt-arms-s.mjs
```
