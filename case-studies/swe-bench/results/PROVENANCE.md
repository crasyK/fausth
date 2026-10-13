# Track S provenance (freeze)

> **RETRACTED (2026-10-13) — invalid measurement, not a negative result.** Every task_success /
> ground_truth_pass number in this document was produced by a grader that never applied the gold
> `test_patch`, ran FAIL_TO_PASS ids through Fausth's own `.venv` pytest without the repository
> installed (`ModuleNotFoundError: django`), used Django/SymPy ids that are not pytest node ids, and
> hardcoded `test_tampering=false` (audit SCR-1/CASE-1). A 0% was structurally guaranteed. The
> numbers below are kept only as **invalid, superseded** history. Current grader + self-test:
> [`../GRADER-VALIDATION.md`](../GRADER-VALIDATION.md); status of every claim:
> [`../../CLAIMS-STATUS.md`](../../CLAIMS-STATUS.md).


**Frozen:** 2026-08-04 · **No new SWE/Gemma runs in this cycle**

## Source reports

| Artifact | Role |
|----------|------|
| `HRI-S-STATUS-REPORT.md` | Pre-v3 diagnosis |
| `HRI-S-IN-IMPL-REPORT.md` | v3 pipeline + levers 1–2 |
| `OPT-ARMS-V3-COMPARISON.md` | v2 vs v3 table |
| `claim.yml` | Bounded negative claim |
| `residuals.json` | Failure taxonomy |

## Key run ids

| Run | Scored | task_success |
|-----|--------|--------------|
| `hri-swe-gemma-full` | 50 (25 CB + 25 PC) | 0% |
| `hri-swe-opt-arms-v3-baseline` | 8/8 | 0% |
| `hri-swe-opt-arms-v3-budget` | 7/8 | 0% |
| `hri-swe-opt-arms-v3-mutable` | partial | 0% |
| `hri-swe-opt-arms-v3-optimize` | partial | 0% |

## Commit anchors

- Frozen full: `acb4bb02c3a3e90249e193a1b5470cf9f43d6e6d`
- Opt-arms v3: `d200db14dc70c0c3991324d993648bf72a8baf8c`

## Independence

- Grader runs FAIL_TO_PASS pytest on agent worktree after run
- Agent cannot set `grade_exit_code` directly
- Mutable harness patches require `fausth select` with holdout fixtures (not exercised to positive utility)

## Reopen

See `claim.yml` `reopen_trigger`.
