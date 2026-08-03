# HRI Track T — cb-todo-delegate harness report

Audience: researchers / engineers reading Fausth case-study results.  
Study: `tau-bench-retail-hri` · Track T · model fixed at `kit.gemma4-31b-it` · harness-only optimization.

## Executive summary

| Arm | Task success | Rate |
|---|---:|---:|
| Frozen gemma-full CB | 3/25 | 12% |
| todo-delegate v1 | 15/25 | 60% |
| todo-delegate v2 (post-fixes) | 20/25 | 80% |

- **Model fixed:** `kit.gemma4-31b-it` (same kit deployment across arms compared here).
- **Absolute lift vs gemma-full CB:** +17 tasks (**+68 pp**).
- **v1 → v2:** +5 tasks (**+20 pp**); false_completion 10/25 → 5/25.
- **Decision:** accept the remaining 5 fails; move optimization focus to **Track S**.

v2 bootstrap CI (clustered, task success): 0.80 [0.64, 0.96]. Wilson: [0.61, 0.91].

## Study framing

- **Track T** = τ-bench retail, curated **N=25** tasks (`retail-000` … `retail-096` step-4 subset). Gold actions + customer instructions imported 1:1 from sierra-research/tau-bench. Grade: `grade.kind: tau_policy` (DB hash vs gold mutating actions + required outputs).
- **Constraint:** same model; **harness-only** optimization (no model swap, no fine-tune, no gold value leakage into prompts beyond structural slot seeding).
- **Primary arm:** `cb-todo-delegate` — pipeline `intake → worker → finalize` (`manifest.yml` `harnesses.cb-todo-delegate`).
- **Baselines (context):**
  - `hri-tau-gemma-full`: CB 3/25 (12%), PC 3/25 (12%) — frozen single-agent CB/PC twin.
  - opt-arms v2 (partial / smaller matrices): `cb-optimize` ~22%, `cb-mutable` ~15%; native/budget/baseline subsets ~50% on small n — none approached full-N todo-delegate utility.
- Protocol: `docs/case-studies/PROTOCOL.md`. Manifest: `case-studies/tau-bench/manifest.yml`.

## Harness design

`cb-todo-delegate` decomposes retail policy work into typed **slots**, then forces the worker to fill every slot before yield.

### Pipeline

1. **Intake (host-seeded)**  
   Reads gold *mutating tool names* (not gold kwargs/values) and required customer outputs. Seeds `tau/todos.json` with:
   - one `mutate_*_<tool>` slot per required mutating tool name;
   - one **report** slot per required output fact (amount, tracking #, payment label, etc.).  
   No gold values / item ids / payment method ids are written into slot values.

2. **Worker**  
   Loop over open slots:
   - `tau.invoke` for the tool named in the mutate slot id;
   - `todo.complete(id=<verbatim slot id>, value=…)`;
   - `phase.yield` gated on `open_todos=0`.  
   Limits: `max_steps: 40`, `max_tool_calls: 36`, `continue_after_deny: true`.

3. **Finalize**  
   Writes `tau/final.txt` from filled slot values so GTP / graders see a stable completion artifact.

### Key engines / gates

| Surface | Role |
|---|---|
| `todo.complete` | Marks a slot filled; mutate slots should follow a successful (or explicitly “cannot modify”) path; later tightened with `actions.jsonl` evidence gate |
| `tau.invoke` | Whitelisted retail CLI (`world/tau.mjs`) — returns / exchanges / cancels / modifies / refund calc / lookups |
| `continue_after_deny` | Deny must continue the turn **and** deliver the observation (verify-evidence / completion-gate denials otherwise orphaned the agent) |
| Soft-retry (host) | If slots remain unfilled after worker exit, host may re-invoke worker on the same worktree |

Slot-id discipline is prompt-critical: ids must be copied **verbatim** from `tau/todos.json`; inventing ids or substituting `cancel_pending_order` for modify/return/exchange is explicitly banned.

## Chronology of fixes (concise)

Ordered by dependency; each item landed before or between the v1/v2 full-N runs.

1. **Env:** implement `modify_pending_order_items` in `world/tau.mjs` (previously missing → cascade failures on pending modifies).
2. **Pipeline:** give worker the **full** `max_steps` budget (not `min(14, …)` phase clipping).
3. **Engine:** verify deny continues **and** delivers observation under `continue_after_deny`.
4. **Prompt:** verbatim slot ids; ban cancel-as-substitute for modify / exchange / return.
5. **Host:** soft-retry if slots unfilled; seed **per-output** report slots (not a single catch-all report).
6. **Minimal policy / user-sim:** `mutate_*_<tool>` must match the invoked tool; mind-change / `answers[0]` handling for 072 / 084 / 092 personas.
7. **Tool + gate:** cancel tool description (whole-order + reason); `todo.complete` gated on `actions.jsonl` evidence.

**Residual known issues (not fixed before accepting v2):**

- Soft-retry **without re-seed** of `tau` DB / worktree → contaminated `get_order_details` and mutate no-ops.
- `modify_pending_order_payment` still missing from invoke whitelist.
- Empty `new_item_ids` (and empty modify item lists) accepted by CLI → hollow “success” exchanges.

## Results

### Headline table

| Condition | Run id | Successes | Rate | False completion | Notes |
|---|---|---:|---:|---:|---|
| gemma-full CB | `hri-tau-gemma-full` | 3/25 | **12%** | 17/25 | Frozen CB; PC also 3/25 |
| todo-delegate v1 | `hri-tau-todo-delegate-v1` | 15/25 | **60%** | 10/25 | First full-N pipeline |
| todo-delegate v2 | `hri-tau-todo-delegate-v2` | 20/25 | **80%** | 5/25 | Post-fix sweep |

Lift: gemma-full CB → v2 = **+17 / +68 pp**. v1 → v2 = **+5 / +20 pp**.

v2 engagement: 25/25. Denial recovery (when denies occurred): 8/11. Median tool steps (completed): 22 (vs gemma-full CB median 37 — denser, less thrash).

### v2 PASS / FAIL lists

**PASS (20):** 000 004 012 016 020 024 032 036 044 048 056 060 068 072 076 080 084 088 092 096  

**FAIL (5):** 008 028 040 052 064  

All five fails are `false_completion` (completion allowed, GTP fail). None are infrastructure / missed_completion.

### Accepted residual fails (summary)

Cross-cut and per-task (detail canvas cited below):

| Task | Mode | Soft-retry contamination | Primary failure |
|---|---|---|---|
| **008** | Wrong 2-item exchange + soft-retry shadow | yes | Asked bottle+lamp; gold desk-lamp only; retry saw exchange already requested → cannot-modify false_completion |
| **028** | Gold returns noop on retry | yes | First-pass kwargs matched gold; soft-retry on contaminated DB → returns Error non-delivered; filled cannot-modify |
| **040** | Missing payment tool | no | `modify_pending_order_payment` absent; fell back to empty `modify_pending_order_items`; Mastercard vs `mastercard` |
| **052** | Hollow exchange | no | `new_item_ids=[]` accepted; gold `5996159312→9228757377` never applied |
| **064** | Wrong variant + contamination + transfer | yes | Worktree already `6117189161` modified; gold `1810466394→6700049080`; abandoned to human |

**Analysis artifacts**

- Canvas: `~/.cursor/projects/home-mark-fausth/canvases/tau-todo-delegate-v2-fail-analysis.canvas.tsx`
- Related canvases: `tau-todo-delegate-vs-baselines.canvas.tsx`, `tau-todo-delegate-fail-traces.canvas.tsx`
- Live report tree: `live/reports/case-studies/tau-bench/hri-tau-todo-delegate-v2/`

## What we claim / do not claim

**Claim**

- Harness changes alone lifted utility on fixed Gemma (`kit.gemma4-31b-it`) for Track T retail N=25: **12% → 80%** task_success vs frozen gemma-full CB.
- Slot-seeded pipeline + deny-continue + tool/env completeness explain the bulk of the lift; v2 fixes closed five additional tasks over v1.

**Do not claim**

- SOTA on τ-bench (any split, any model, any protocol).
- That the residual 5 fails are solved or close to solved without further env/host work.
- That soft-retry is unsafe even with re-seed (re-seed is now implemented; see full-retail/levers report).
- That opt-arms / native baselines were full-N matched competitors at the same commit (they were not).

## Artifacts

### Headline runs

| Run id | Path (summary) | Live raw |
|---|---|---|
| `hri-tau-gemma-full` | `case-studies/tau-bench/results/hri-tau-gemma-full.summary.json` | `live/reports/case-studies/tau-bench/hri-tau-gemma-full/` |
| `hri-tau-todo-delegate-v1` | `case-studies/tau-bench/results/hri-tau-todo-delegate-v1.summary.json` | `live/reports/case-studies/tau-bench/hri-tau-todo-delegate-v1/` |
| `hri-tau-todo-delegate-v2` | `case-studies/tau-bench/results/hri-tau-todo-delegate-v2.summary.json` | `live/reports/case-studies/tau-bench/hri-tau-todo-delegate-v2/` |

v2 provenance: commit `d200db14…`, started `2026-08-02T13:49:47Z`, finished `2026-08-02T14:47:54Z`, `max_steps: 40`, reps=1.

### Harness / world / manifest

- Manifest: `case-studies/tau-bench/manifest.yml`
- Pipeline root: `case-studies/tau-bench/harnesses/cb-todo-delegate/`
  - `agents/intake/agent.yml`
  - `agents/worker/agent.yml`
  - `agents/finalize/agent.yml`
- World / CLI: `case-studies/tau-bench/world/tau.mjs` (+ DB / wiki)
- Scoring: `case-studies/tau-bench/expected/scoring.yml`
- Case-study README: `case-studies/tau-bench/README.md`

### Diagnostic / intermediate runs (non-headline)

`hri-tau-todo-delegate-likely-v1`, `unconfirmed-v1`, `still-fail-v1`, `056-clean-v1`; smoke suite `tau-todo-delegate-smoke-*`, `tau-todo-delegate-000-todocomplete`. Opt-arms / native: `hri-tau-opt-arms-v2-*`, `hri-tau-native-baseline-v1`.

### Canvases

- `tau-todo-delegate-v2-fail-analysis.canvas.tsx` — accepted residual 5
- `tau-todo-delegate-vs-baselines.canvas.tsx` — rate comparison
- `tau-todo-delegate-fail-traces.canvas.tsx` — earlier fail traces

## Follow-ups (deferred)

Accepted for later; **not** blocking Track T N=25 close-out. Status after full-retail / levers work:

1. ~~**Re-seed** before worker soft-retry~~ — **done** (`scripts/case-study-coding.mjs`; see `HRI-T-FULL-RETAIL-AND-LEVERS-REPORT.md`).
2. **Implement** `modify_pending_order_payment` in `tau.mjs` invoke path.
3. **Validate** non-empty exchange / modify item lists (`new_item_ids`, item_ids) — reject hollow calls.
4. Slot-backed mutation guard + resolve-no-mutate — **done** (`engines/ts/src/adapters/local.ts`).
5. Optional: world ID error hints (lever 3); mind-change user_sim for 008-class asks.
6. Optional full-N **T re-run** after remaining env fixes if curiosity utility must be refreshed (does not replace N=25 claim).

Detailed full-retail + lever results: `case-studies/tau-bench/results/HRI-T-FULL-RETAIL-AND-LEVERS-REPORT.md`.

## Handoff to Track S

Track T todo-delegate is **accepted at 20/25 (80%)** with five documented residuals. Optimization focus moves to **Track S**, which remains at **0% task_success** despite implementation engaging post Phase-0. See companion status report: `case-studies/swe-bench/results/HRI-S-STATUS-REPORT.md`. Track T follow-ups above are backlog only unless a T re-run is explicitly requested.
