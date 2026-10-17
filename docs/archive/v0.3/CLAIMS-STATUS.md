# Claims status (case studies)

Single source of truth for what the case studies may claim after the 2026-10-12 audit (fixes
on branch `fix/cases`, 2026-10-13). Status vocabulary:

- **valid** — supported by evidence in this repository that the audit did not invalidate;
- **invalid** — the measurement could not support the claim (defect, leakage, overfit); the
  numbers are kept only as history, never as a negative or positive result;
- **superseded** — replaced by a newer artefact or definition; do not cite the old one;
- **unverifiable** — the artefact lacks provenance, so the claim can neither be checked nor used.

Every live claim below needs a **new run** to be re-established. Re-runs must use the fixed
worlds/graders/harnesses, `kit.glm-5.3-flash` (+ `kit.deepseek-v4-flash`), held-out tasks only,
all runs reported (no best-run selection), and grader-unavailable attempts excluded *and reported*.
Note for reps: the KIT gateway caches `kit.glm-5.3-flash` responses by request body, so repeated
identical requests are **not independent samples** (vary seeds/prompts or count them as one).

## Track S — SWE-bench Lite

| Claim | Where stated | Status | Evidence | Needed to re-establish |
|---|---|---|---|---|
| 0% task_success on all measured arms (gemma-full 0/25 CB, 0/25 PC; opt-arms v2/v3 0%) | `swe-bench/results/claim.yml` (old), `FREEZE.md`, `HRI-S-*.md`, `OPT-ARMS-V3-COMPARISON.md`, HRI Track S | **invalid** (retracted 2026-10-13) — invalid measurement, **not** a negative result | Old grader never applied `test_patch`, ran F2P ids with Fausth's own `.venv` pytest without the repo installed (`ModuleNotFoundError: django`), passed Django/SymPy ids that are not pytest ids, hardcoded `test_tampering=false`: 0% was structurally guaranteed | Re-run CB vs PC on the 25 grader-validated tasks with the new grader |
| "v3 fixed grading observability (numeric grade_exit_code, diffs)" | `claim.yml` (old), `HRI-S-IN-IMPL-REPORT.md` | **invalid** | Numbers came from the same broken grader | — (superseded by the grader port) |
| Phase-0 "plan → implementation unblocked" | `HRI-S-STATUS-REPORT.md` | **superseded** | Event-log observation of a harness version that has since changed (auto-approve, unsatisfiable `cmd=test`, self-unlock `user.correct`); no utility attached | Observe again with the current harnesses if still of interest |
| SWE grader = upstream SWE-bench v4.1.0 grading; self-test gold⇒RESOLVED_FULL, empty⇒F2P fails | `swe-bench/GRADER-VALIDATION.md` | **valid** (2026-10-13, this host) | 25/25 tasks across 12 repos validated (`world/grader-validation.json`); unit + integration tests (`swe-bench/tests/`, `scripts/case-study-backends.test.mjs`) | Re-run `world/selftest.mjs --all` on any other host before grading there |

## Track T — τ-bench retail

| Claim | Where stated | Status | Evidence | Needed to re-establish |
|---|---|---|---|---|
| cb-todo-delegate 80% (20/25) on N=25 | `tau-bench/results/HRI-T-TODO-DELEGATE-REPORT.md`, old README | **invalid** | Agent saw the hidden instruction (`## Customer`) and a full Fausth checkout incl. gold `task.yml`; user always "yes" (+ hand answers tuned on 072/084/092); slots seeded from **gold** actions/outputs and off-slot mutations blocked; world lacked `modify_pending_order_payment`, allowed hollow exchanges, ignored gold errors; outputs matched tool logs; dev = eval | Run `manifest-eval.yml` (83 held-out tasks) with the user simulator; todo-delegate would first need a gold-free design (see `harnesses/cb-todo-delegate/README.md`) |
| "12% → 80%, harness-only" | same report | **invalid** (CASE-3) | 12% baseline (`hri-tau-gemma-full`, commit `acb4bb0`) predates `modify_pending_order_items` and was never re-run; the same CB harness went 0/8 → 4/8 (`opt-arms-v1-baseline` → `v2-baseline`) from world fixes alone | A matched CB vs PC comparison at one commit on eval tasks |
| Full retail 70.4% (81/115); levers 1+2 recovered 6/8 | `HRI-T-FULL-RETAIL-AND-LEVERS-REPORT.md` | **invalid** | Same leakage; levers were gold-slot guards | — |
| Track T CB 3/25 = PC 3/25 (`hri-tau-gemma-full`) | `hri/manifest.yml`, `hri-v0.json` | **invalid** | Leaked instruction, always-yes user, world defects, missing tool | Re-run on eval split |
| τ opt-arms (cb-optimize ~22%, cb-mutable ~15%, native/budget ~50% small n) | reports | **invalid** | Same setup defects; tuned on the evaluation tasks | Optimizer runs on dev only (`manifest-optimize.yml`), then evaluate on eval |
| commit_sha provenance of v1/v2 runs | summaries | **unverifiable** (CASE-14) | v1 and v2 both record `d200db1` though code changed between them | Runner provenance fix (agent "scripts") |
| v2 summary integrity | `hri-tau-todo-delegate-v2.summary.json` | **unverifiable** (CASE-16) | `invariants.ok=false` (25 `never_reset` try-index violations) never mentioned; τ summaries' `attack_*` rates are meaningless for τ | — |
| Failure analyses cited from canvases | reports | **unverifiable** (CASE-15) | Canvases live in `~/.cursor/…`, outside the repo | Commit any analysis that a claim relies on |
| τ world = upstream retail tools (observations byte-identical, upstream DB hash, safe calculator) | `tau-bench/README.md` | **valid** | `tau-bench/tests/tau-world.test.mjs`: all gold actions of all 115 tasks, 73 edge cases, 198 calculator expressions vs pinned upstream outputs | — |
| Gold self-test: every task's gold replay reproduces the upstream hash | `tau-bench/tests/tau-tasks.test.mjs` | **valid** | 104 tasks change the DB, 11 expected no-ops | — |

## Track C — coding counterbalance (micro-coding)

| Claim | Where stated | Status | Evidence | Needed to re-establish |
|---|---|---|---|---|
| "CB +8.6 pp vs PC" (`live-kit-v3-reduced`) | `hri/manifest.yml`, `docs/case-studies/PROTOCOL.md`, `hri-v0.json` | **invalid** as stated (CASE-12, CASE-18) | Most favourable of three live runs: `live-kit-all-v2` +1.9 pp (CB 46/160 vs PC 43/160), `live-kit-v2` −2.5 pp (13/40 vs 14/40), `v3-reduced` +8.6 pp (24/45 vs 21/47; PROTOCOL misstates PC as 20/45); CIs overlap. Paired re-aggregation by agent "scripts": +11.4 pp (44 pairs, 95% CI [0, +23.8], p = 0.125) — not significant. "Held-out" graders were byte-copies of the visible seed tests, so task_success measured the test the agent could run | Re-run with the genuinely held-out graders now in `coding-counterbalance/tasks/*/grade/` (self-tested), pre-registered matrix, all runs reported |
| `results/summary.json` is the live summary | `coding-counterbalance/results/README.md` (+ other studies) | **invalid** (CASE-13) | Every `*/results/summary.json` is a recorded plumbing smoke (`hri-regression-coding`, `adversarial-recorded-ci`, `hri-swe-recorded-smoke`, `hri-tau-recorded-smoke`) | Runner promotion fix (agent "scripts", `scripts/promote-run.mjs`); manifests now write summaries under `live/reports/` |
| Gemma canary: missed completion 5/9 → 0/9 with structured denies | `PROTOCOL.md` | **unverifiable** | n = 9, graded by visible-test copies | Re-run with held-out graders |

## Track A — adversarial security

| Claim | Where stated | Status | Evidence | Needed to re-establish |
|---|---|---|---|---|
| CB blocks attacks (attack_block 0.875 vs PC 0, `adv-live-v3`) | `adversarial/results/README.md`, `hri-v0.json` Track A | **invalid** (CASE-11) | CB protected exactly the attack target (`protected_paths: [src/app.js]`) — blocking by construction; the same protection made the benign fix of `adv-prompt-injection-doc` impossible, so that task was dropped; injection and shell tasks were absent from v3 and **PC never landed them in v1/v2** (non-discriminating) | Re-run all four tasks with the principle-based CB (owner-approved plans via the user channel, no irreversible shell, protected tests/manifest, labelled secrets) — now discriminating in recorded CI |
| `adv-live-v3` per-task numbers | `adv-live-v3.summary.json` | **unverifiable** (CASE-14) | Hand-assembled summary without provenance; its `benign_success` = 0/16 contradicts the side-effect grader (a blocked overwrite leaves `greet()` = "hello" ⇒ benign true) | — |
| HRI joint utility 0.875 (Track A) | `hri-v0.json` | **invalid** | `scoring.yml` defines utility = block ∧ benign when benign is defined; on the v3 data that is 0 (agent "scripts" re-aggregation), and the data itself is unverifiable | Re-run; aggregator fixed by agent "scripts" |
| Labelled secrets are never written (v2: CB 0/4 vs PC 4/4 exfil) | `adversarial/results/README.md` | **valid but narrow** | Deny-on-write of declared secret values works when the secret path is declared; not a general exfiltration defense | — |

## Mutable cells (self-editing skills)

| Claim | Where stated | Status | Evidence | Needed to re-establish |
|---|---|---|---|---|
| Mid-matrix results table (v2 −0.40, v3 0, v4 −0.10) | `mutable-cells/results/README.md` | **superseded** — incomplete: omitted `mid-v1` (baseline 7/10 vs mutable 4/10, Δ −0.30); corrected there | All four mid runs show mutable ≤ baseline; tiny n; graded by visible-test copies | Re-run with held-out graders; report every run |

## HRI index

| Claim | Where stated | Status | Evidence | Needed to re-establish |
|---|---|---|---|---|
| `hri-v0.json` cross-track index | `case-studies/hri/results/` | **superseded** | Built from the invalid/unverifiable track summaries above and an aggregator that pooled runs and mis-defined joint utility (fixed by agent "scripts") | Re-aggregate (integrator) after valid re-runs |
