# HRI Track S — in-implementation improvements report

**Audience:** researchers / engineers reading Fausth case-study results.  
**Study:** `swe-bench-opt-arms` · Track S · model fixed at `kit.gemma4-31b-it`  
**Scope:** Test/grading pipeline fix + harness levers 1–2 (plan-path write enforcement, stderr on verify deny)  
**Companion:** pre-change diagnosis in [`HRI-S-STATUS-REPORT.md`](HRI-S-STATUS-REPORT.md)

---

## Executive summary

| Question | Answer |
|----------|--------|
| Did the **measurement pipeline** break? | **Fixed.** v3 scored attempts have numeric `grade_exit_code` and persisted `grade.details`; v2 had `grade_exit_code: null` on all graded SWE attempts. |
| Did **levers 1–2** ship? | **Yes.** Approved-path capture, warn-then-deny off-plan writes, stderr/stdout on `verify_evidence_failed`. |
| Did **task_success** improve? | **No.** 0% on all completed and partial v3 arms — flat vs v2. |
| Recommendation | Accept pipeline/lever work; **next optimization surface** is model recovery from test failures (env/setup) and wrong-target edits, not pytest PATH or empty diffs. |

**Bottom line:** Infrastructure and observability goals met; **utility hypothesis not confirmed** on `kit.gemma4-31b-it`.

---

## What we built

### Prerequisite — test & grading pipeline

| Component | Change |
|-----------|--------|
| `scripts/pytest-runner.sh` | Resolves Fausth `.venv/bin/pytest` for shell `cmd=test` |
| `scripts/opt-arms-tmux.mjs` | `shellActivate()` (nvm + venv + `.env`); `--track` / `--arm` filters |
| `scripts/case-study-coding.mjs` | Patches kit deployment test command; writes `grade_kind` + `details` to `grade.json` |
| `scripts/case-study-backends.mjs` | `resolvePytestBinary()`, `captureSweWorktreeDiff()` (mirror `git diff` for `git_checkout` seeds), `gradeSweBench` uses both |

**Validation:** `node scripts/swe-pipeline-smoke.mjs django__django-10914` → numeric `grade_exit_code`, non-empty diff, `grade_skipped=false`.

### Lever 1 — plan-path write enforcement (soft)

| Component | Change |
|-----------|--------|
| `scripts/swe-plan-paths.mjs` | Extract paths from plan text / approve events → `.fausth/approved_paths.json` |
| `engines/ts/src/adapters/plan-paths.ts` | TS path extraction + `loadApprovedWritePaths()` |
| `engines/ts/src/adapters/local.ts` | `user.approve` sets `allowed_write_paths`; `fs.write_scoped` warns once then denies `off_plan_path` |
| Harness YAML | `off_plan_writes: 0` in implementation agents; shell tool description updated |

**Observed in v3:** `[info] … approved write paths (N): …` on every plan phase. Final `off_plan_writes` stayed **0** on scored budget/baseline reports — either models stayed on-plan or off-plan paths were not heavily exercised.

### Lever 2 — surface test stderr on verify deny

| Component | Change |
|-----------|--------|
| `engines/ts/src/runtime.ts` | On `verify_evidence_failed` for `shell.run_allowlisted`, observation includes truncated stdout/stderr, `exit_code`, recovery hint |

**Observed in v3:** django implementation events show full pytest collection errors, e.g. `ModuleNotFoundError: No module named 'django'`, with hint *"Read stdout/stderr above, fix the approved source file, then re-run cmd=test"*.

### Tests added

- `scripts/swe-plan-paths.test.mjs`
- `scripts/case-study-backends.test.mjs`
- `engines/ts/src/adapters/plan-paths.test.ts`
- `engines/ts/src/adapters/local.test.ts` (off-plan warn/deny)
- TS engine suite: **71 tests pass**

### Measurement tooling

- `scripts/compare-opt-arms-s.mjs` — v2 vs v3 `task_success_any_of`
- `scripts/opt-arms-sequential.mjs` — one SWE arm at a time (KIT overload mitigation)
- `scripts/track-s-measure.sh` — django smoke → sequential v3 (optional chain)

---

## Experiment design — opt-arms v3

| Parameter | Value |
|-----------|-------|
| Run IDs | `hri-swe-opt-arms-v3-{baseline,budget,mutable,optimize}` |
| Manifest | `case-studies/swe-bench/manifest-optimize.yml` |
| Tasks | 8-task pilot slice (same as v2) |
| Model | `kit.gemma4-31b-it` |
| Concurrency | Started sequential (1 arm); relaunched **4 SWE arms parallel** after τ finished |
| End state | Operator-killed mutable/optimize mid-run |

### Django smoke (optional)

| Run ID | Outcome |
|--------|---------|
| `hri-swe-django10914-levers-v1` | `infrastructure_failure` — KIT `fetch failed` during implementation |
| `hri-swe-django10914-levers-v2` | Killed mid-implementation (no scored ledger) |

Offline pipeline smoke validates grading without live KIT.

---

## Results

### Scoreboard — v3 vs v2

| Arm | v2 any-of success | v3 status | v3 scored | v3 task_success | v3 infra |
|-----|-------------------|-----------|-----------|-----------------|----------|
| baseline (`counterbalanced`) | 0/7 (0%) | **Complete** | 8/8 | 0/8 | 0 |
| budget (`cb-budget`) | 0/8 (0%) | **Complete*** | 7/8 | 0/7 | 1 (django) |
| mutable (`cb-mutable`) | 0/8 (0%) | **Partial**† | 22 tries | 0 | 0 |
| optimize (`cb-optimize`) | — | **Partial**† | 22 tries | 0 | 0 |

\* budget `django__django-10914` ended `infrastructure_failure` (KIT `fetch failed` on implementation).  
† Killed on `psf__requests-1963` try 3/5; tasks 1–4 exhausted all 5 tries each; pylint/pytest/django not started.

**Headline:** `task_success_any_of` **unchanged at 0%** for completed arms.

### Pipeline metrics (graded attempts only)

| Metric | v2 budget | v3 baseline | v3 budget | v3 mutable† | v3 optimize† |
|--------|-----------|-------------|-----------|-------------|--------------|
| `grade_exit_code` numeric | **0/8** | **8/8** | **7/7** | **22/22** | **22/22** |
| `grade_exit_code` null | 8/8 | 0/8 | 0/7 | 0/22 | 0/22 |
| `grade_skipped` | 0 | 0 | 0 | 0 | 0 |
| Non-empty `worktree.diff` | **0/8** | **4/8** | **3/7** | **12/22** | **8/22** |
| `engaged` (scored) | 8/8 | 8/8 | 7/7 | 22/22 | 22/22 |

† Partial runs — not comparable to full 8-chain any-of denominator.

**Key delta vs v2:** grading and diff capture now produce **auditable artifacts** even when utility is zero.

### Per-task notes (completed arms)

All 8 pilot tasks scored on **baseline**; budget missing django.

| Task | baseline `grade_exit` | Dominant deny reasons (baseline) |
|------|----------------------|----------------------------------|
| `pallets__flask-4045` | 1 | `empty_proposal`, `sequence_requirement_failed` |
| `mwaskom__seaborn-2848` | 1 | `limit_exceeded` |
| `pydata__xarray-3364` | 1 | `empty_proposal`, `output_schema_invalid` |
| `astropy__astropy-12907` | 1 | `completion_gate_failed`, `verify_evidence_failed` |
| `psf__requests-1963` | 1 | `completion_gate_failed`, `output_schema_invalid` |
| `pylint-dev__pylint-5859` | 1 | `completion_gate_failed`, `output_schema_invalid` |
| `pytest-dev__pytest-11143` | 1 | `output_schema_invalid`, `limit_exceeded` |
| `django__django-10914` | 1 | `sequence_requirement_failed`, `verify_evidence_failed` |

`ground_truth_pass=false` on every scored attempt. Agents **engage** and often **write**, but patches do not pass FAIL_TO_PASS.

### Failure modes (still dominant post-levers)

1. **`output_schema_invalid` / `empty_proposal`** — model/tool-call formatting; high counts on budget (179+ per arm aggregate).
2. **`completion_gate_failed`** — `test_evidence_current=0` or `open_todos=1` at step limit.
3. **`verify_evidence_failed`** — `cmd=test` exits non-zero; lever 2 now surfaces pytest output (e.g. django: package not installed in worktree).
4. **`limit_exceeded`** — step/tool budget exhausted (research/plan burn still present but out of scope for this sprint).
5. **Wrong target** — approved paths logged but models still pick adjacent files (e.g. `django/conf/settings.py` vs `global_settings.py`; `storage.py` in earlier runs).

### Infrastructure

| Phase | Issue |
|-------|-------|
| First v3 launch (8 parallel incl. τ) | SWE implementation `fetch failed` on task 1 |
| Sequential relaunch | No infra failures on baseline |
| 4 SWE parallel (τ done) | No infra until budget django at end |
| Django smoke v1/v2 | KIT timeout / hung implementation |

**Lesson:** 4 concurrent SWE arms is sustainable; 8-way KIT saturation is not.

---

## Lever assessment

| Lever | Shipped | Measured effect |
|-------|---------|-----------------|
| Pytest PATH + grading | ✅ | `grade_exit_code` numeric; `details.FAIL_TO_PASS` visible in `grade.json` |
| Diff capture | ✅ | Non-zero diffs on edited worktrees (mirror-based for git seeds) |
| Plan-path enforcement | ✅ | Paths logged; warn/deny code tested in unit tests; **no scored off-plan writes** in v3 sample |
| Stderr on verify deny | ✅ | Recoverable pytest output in observations (django confirmed) |
| **Utility (`task_success`)** | — | **No lift** |

Levers improved **debuggability and grading integrity**; they did not, alone, convert engagement into passing tests on this model.

---

## Artifact index

### Frozen summaries (`case-studies/swe-bench/results/`)

| File | Status |
|------|--------|
| `hri-swe-opt-arms-v3-baseline.summary.json` | Complete |
| `hri-swe-opt-arms-v3-budget.summary.json` | Complete (7/8 scored) |
| `hri-swe-opt-arms-v3-mutable.PARTIAL.json` | Partial metadata |
| `hri-swe-opt-arms-v3-optimize.PARTIAL.json` | Partial metadata |
| `OPT-ARMS-V3-COMPARISON.md` | v2 vs v3 table |
| `HRI-S-IN-IMPL-REPORT.md` | This document |

### Live run roots (`live/reports/case-studies/swe-bench/`)

- `hri-swe-opt-arms-v3-{baseline,budget,mutable,optimize}/` — ledgers, attempts, `grade.json`, `worktree.diff`
- Logs: `live/reports/kit-probe/hri-swe-opt-arms-v3-*.log`

### Reproduce comparison

```bash
node scripts/compare-opt-arms-s.mjs
node scripts/swe-pipeline-smoke.mjs django__django-10914
OPT_ARMS_RUN_PREFIX=v3 node scripts/opt-arms-tmux.mjs status --track swe
```

---

## Chronology

1. **Diagnosis** ([`HRI-S-STATUS-REPORT.md`](HRI-S-STATUS-REPORT.md)) — pipeline engages impl; utility 0%; pytest null; empty diffs.
2. **Implementation** — pipeline + levers 1–2 (this sprint).
3. **v3 pilot** — sequential start → parallel 4 SWE; baseline + budget complete; mutable/optimize partial.
4. **Operator stop** — runs killed; report frozen.

---

## Deferred (out of scope)

- Lever 3: research/plan budget burn control
- Stacked “winners” harness
- Full N=25 re-run
- Python engine parity for off-plan paths (SWE uses TS engine only)
- Worktree pytest env (install package under test before `cmd=test`)

---

## Recommendations

### Accept

- Test pipeline and grading changes — **keep**.
- Lever 2 (stderr on deny) — **keep**; enables env-aware recovery if model uses it.
- Lever 1 (soft off-plan) — **keep**; low harm; may help on wrong-file regressions at scale.

### Next experiments (if continuing Track S)

1. **Scoped test command** — run FAIL_TO_PASS nodes only (or `pip install -e .` before `cmd=test`) so verify signal matches SWE-bench grading.
2. **Harder off-plan enforcement** — deny first off-plan write on high-confidence plan paths (measure false-deny rate).
3. **Plan burn cap** — separate budget for research/plan vs implementation.
4. **Model or harness teach-in** — tool description for “install editable package before test” when pytest import fails.

### Do not re-run without changes

- Another full v3 parallel pilot on the same levers expecting utility lift — **0% signal** on completed arms.
- 8-way KIT concurrency for SWE + τ — infra failures return.

---

## Provenance

- **Harness commit (v3 runs):** `d200db14dc70c0c3991324d993648bf72a8baf8c` (from run provenance)
- **v3 baseline window:** 2026-08-03 07:25 – 10:28 UTC
- **v3 killed:** 2026-08-03 ~21:34 local
- **Frozen gemma-full bundle:** not overwritten (`hri-swe-gemma-full`)
