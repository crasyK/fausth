# HRI Track S — status & diagnosis report

> **Update (2026-08-03):** In-implementation pipeline + levers 1–2 shipped and measured in opt-arms v3. See **[`HRI-S-IN-IMPL-REPORT.md`](HRI-S-IN-IMPL-REPORT.md)** for full results (utility still 0%; grading/observability fixed).

Audience: researchers / engineers reading Fausth case-study results.  
Study: `swe-bench` / `swe-bench-opt-arms` · Track S · model fixed at `kit.gemma4-31b-it` · harness-only optimization.

Companion: Track T closed for now at **20/25 (80%)** — see `case-studies/tau-bench/results/HRI-T-TODO-DELEGATE-REPORT.md`.

## Executive summary

| Arm | Task success | Rate | Notes |
|---|---:|---:|---|
| Frozen gemma-full CB | 0/25 | 0% | Almost never reached implementation |
| Frozen gemma-full PC | 0/25 | 0% | Completions that fired were false_completion |
| opt-arms v2 baseline (`counterbalanced`) | 0/7 | 0% | Impl engaging on most |
| opt-arms v2 budget (`cb-budget`) | 0/8 | 0% | Impl 8/8; dominant `verify_evidence_failed` |
| opt-arms v2 mutable (`cb-mutable`) | 0/37 | 0% | Tries≤5; still zero utility |

- **Model fixed:** `kit.gemma4-31b-it`.
- **Phase-0 unblock succeeded:** plan approve → yield → **implementation starts** (spot checks + opt-arms v2).
- **Utility still zero:** patches / tests do not produce `ground_truth_pass`; `task_success` remains 0.
- **Decision (handoff from T):** accept T residuals; next harness work targets S **in-implementation** failure modes (not re-litigating plan approve).

## Study framing

- **Track S** = SWE-bench Lite, curated **N=25** instances (verbatim problem statements, base commits, FAIL_TO_PASS / PASS_TO_PASS). Selection: `case-studies/swe-bench/instances/selection.json`.
- **Constraint:** same model; harness-only optimization. Not a SWE-bench leaderboard claim — Fausth **CB vs PC** (and CB variants) only (`docs/testing/HRI.md`).
- **CB pipeline:** `research → plan → implementation` (`manifest.yml` / `manifest-optimize.yml`).
- **Grade:** held-out tests after agent writes; `ground_truth_pass` from test exit; `task_success` requires GTP + completion policy.
- Protocol: `docs/case-studies/PROTOCOL.md`. Manifests: `case-studies/swe-bench/manifest.yml`, `manifest-optimize.yml`.

## What was unblocked (Phase 0 + opt-arms)

Frozen **gemma-full** CB almost never entered implementation (**1/25** with `plan_approved`). Dominant pre-impl failure mode: plan never approved / discovery burn → implementation never started.

Post–Phase-0 / opt-arms:

| Evidence | Result |
|---|---|
| `hri-swe-budget-django10914-approve-gate-v1` | `plan_approved=1`; implementation engaged (~43 events) |
| `hri-swe-route-a-smoke-v1` | plan approved; impl engaged (~37 events) |
| opt-arms v2-budget | **8/8** attempts reached implementation |
| opt-arms v2-baseline | **6/7** impl event streams non-empty |
| opt-arms v2-mutable | **31/37** scored tries entered impl |

Security surface still holds on scored opt-arms: attack block high; false_completion not the headline S failure.

**Claim so far:** the plan→impl **pipeline gate** is no longer the primary bottleneck.

## What still fails (dominant modes)

All measured S arms remain **0%** `task_success`. After impl starts, failures concentrate as:

### 1. `verify_evidence_failed` on `cmd="test"` (dominant on v2-budget)

Pattern: `fs.write_scoped` → `shell.run_allowlisted` with `cmd="test"` → **exit_code=1** → evidence verify **deny**. Agent typically stops or flails without a recoverable test signal (empty / truncated observation). Example: approve-gate django-10914 ended on first test deny.

### 2. Wrong-target patches

Agent plans one path, writes another (or writes tests / reproduce scripts instead of production source).

| Example | Planned | Wrote |
|---|---|---|
| `django__django-10914` | `django/conf/global_settings.py` | `storage.py` (wrong target) |
| `pylint-dev__pylint-5859` (opt-arms) | `misc.py` | `tests/test_misc.py` + `reproduce_bug.py` |

Plan text is advisory; **no hard write-scope binding** to approved plan paths.

### 3. Research / plan budget burn (`limit_exceeded`)

Orient / list loops consume research+plan step budgets (e.g. 121 events observed on burn patterns) even when yield eventually happens. Steals headroom before impl; on some tasks compounds with late denials.

### 4. Tests fail → `ground_truth_pass=false`

Patches may exist and completion may never unlock (`test_evidence_current` stays 0, `open_todos` stays 1). When tests do run, they fail — no measured arm yet converts an impl engagement into GTP.

### Not the issue (anymore)

- Missing implementation wiring after approve (pipeline starts).
- `discovery_failure` as the universal flag on later opt-arms budget (0/8 on v2-budget score flags).
- Track T–style slot/todo design — S uses a different CB contract (approve / test evidence / write scopes).

## Harness gates (current CB / cb-budget)

### Plan agent

- Tools: read-only `fs.*`, `user.approve` (once), `phase.yield`.
- Sequences: approve-before-yield; deny re-approve.
- No writes / no tests in plan.
- `continue_after_deny: true`.

### Implementation agent

- Tools: `fs.write_scoped`, `shell.run_allowlisted` (`cmd=test|typecheck` allowlist).
- Sequences: write-before-test; test-before-complete.
- `task.complete` requires `test_evidence_current=1` **and** `open_todos=0`.
- Test `exit_code≠0` → verify deny.
- Limits (budget arm): on the order of **90** steps / **80** tool calls for impl (exact values in `harnesses/cb-budget/agents/implementation/agent.yml`).

## Scoreboard (measured)

### Frozen full slice — `hri-swe-gemma-full`

- CB: **0/25**; PC: **0/25** (50/50 scored).
- CB reached implementation **1/25**; discovery_failure heavy on CB (25/25) and PC (20/25).
- PC: 2 false_completions among completions that fired.

### Opt-arms v2 (partial matrices; complete arms)

| Condition | Successes / n | Impl engaging | Headline failure flags |
|---|---:|---|---|
| `counterbalanced` | 0/7 | 6/7 | sparse; plan_approved final often 0 |
| `cb-budget` | 0/8 | 8/8 | `verify_evidence_failed` dominant |
| `cb-mutable` | 0/37 | 31/37 | discovery_failure 6; tries≤5 still 0 utility |

Infra noise present on some mutable/baseline attempts (`fetch failed`); treat utility denominator as scored attempts.

### Spot checks

| Run | Outcome |
|---|---|
| `hri-swe-budget-django10914-approve-gate-v1` | Fail — plan approved, impl engaged, `verify_evidence_failed`, tests exit 1 |
| `hri-swe-route-a-smoke-v1` | Fail — plan approved, impl engaged, `limit_exceeded` + `verify_evidence_failed`, tests exit 1 |

## Chronology (S-relevant)

1. **Frozen gemma-full:** 0/25 CB — plan rarely approved; impl almost never starts.
2. **Phase 0:** scope/path denials + plan approve→yield teachability → smoke shows impl start.
3. **Opt-arms v1/v2:** budget / mutable / baseline / optimize arms — **attribution study**; none lifted `task_success` above 0 on scored S attempts.
4. **Approve-gate smoke:** confirms plan gate; demonstrates in-impl test-deny wall.
5. **Track T diversion:** todo-delegate lifted T to 80%; S left at 0% with clearer post-impl diagnosis.

## What we claim / do not claim

**Claim**

- On fixed Gemma, **harness work unblocked plan→implementation** for Track S CB pipelines.
- Post-unblock, **utility remains 0%**; failures are concentrated in implementation (wrong writes, failing tests, weak deny feedback, some pre-impl budget burn).

**Do not claim**

- Any positive SWE-bench Lite scoreboard delta from opt-arms yet.
- That budget or mutable arms “failed as ideas” — they never cleared the in-impl wall; attribution of *utility* is still undefined until GTP moves.
- That plan-path enforcement or test-output injection are proven lifts (proposed, not measured).

## Proposed next harness levers (deferred — not implemented in this report)

Ordered by expected leverage; keep generic (no per-task gold paths in prompts).

1. **Plan-path write enforcement** — deny `fs.write_scoped` unless path is among approved plan source files (blocks test-only / wrong-file patches).
2. **Surface test stdout/stderr on `verify_evidence_failed`** — give the model a recoverable observation so write→test can iterate inside impl budget.
3. **Research/plan burn control** — tighten orient loops / step budgets so yield happens with impl headroom left.
4. **Optional:** stronger “edit production module first” completion sequencing once (1)+(2) land.

**Suggested first measured experiment (when work resumes):**  
Smoke `django__django-10914` on `cb-budget` with (1)+(2). Success criterion: edit `django/conf/global_settings.py`, passing `cmd="test"`, `task.complete`, `ground_truth_pass=true`.

## Artifacts

| Kind | Path / run id |
|---|---|
| Manifests | `case-studies/swe-bench/manifest.yml`, `manifest-optimize.yml` |
| Harnesses | `case-studies/swe-bench/harnesses/{counterbalanced,cb-budget,cb-mutable,cb-optimize,permissive-control}/` |
| Frozen full | `hri-swe-gemma-full` → `case-studies/swe-bench/results/hri-swe-gemma-full.summary.json` |
| Opt-arms v2 | `hri-swe-opt-arms-v2-{baseline,budget,mutable}` (+ optimize if present) under `case-studies/swe-bench/results/` |
| Approve-gate smoke | `hri-swe-budget-django10914-approve-gate-v1` |
| Route-A smoke | `hri-swe-route-a-smoke-v1` |
| Live reports | `live/reports/case-studies/swe-bench/` |
| Parallel-arms plan | `.cursor/plans/s_t_harness_optimization_78c24b17.plan.md` (or workspace plans copy) |
| Track T companion | `case-studies/tau-bench/results/HRI-T-TODO-DELEGATE-REPORT.md` |

## Relationship to Track T

| Track | Headline | Residual |
|---|---|---|
| **T** | **20/25 (80%)** todo-delegate v2 | 5 accepted fails (soft-retry contamination / payment tool hole / hollow exchange / variant) |
| **S** | **0%** utility; impl **unblocked** | In-impl test deny + wrong-file writes |

T work is **accepted as current best** for the fixed-model harness study. S is the active optimization surface when engineering resumes.
