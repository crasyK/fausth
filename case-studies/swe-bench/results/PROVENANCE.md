# Track S provenance (freeze)

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

See `claim.yml` `reopen_trigger`. Chess stability gate: [`../../chess/results/PROCEDURAL-RELIABILITY.md`](../../chess/results/PROCEDURAL-RELIABILITY.md).
