# HRI Track T — full retail + slot-guard levers

Audience: researchers / engineers reading Fausth case-study results.  
Study: `tau-bench-retail-hri` · Track T · model fixed at `kit.gemma4-31b-it` · harness-only.

This report covers work **after** the accepted N=25 claim (`HRI-T-TODO-DELEGATE-REPORT.md`). It is **not** a re-score of that claim.

## Executive summary

| Run | Scope | Condition | Success | Rate |
|---|---|---|---:|---:|
| todo-delegate v2 (claim) | N=25 stride | `cb-todo-delegate` | 20/25 | **80%** |
| full retail (curiosity) | N=115 full test | `cb-todo-delegate` only | 81/115 | **70.4%** |
| lever 1+2 retry | 8 targeted prior fails | `cb-todo-delegate` | 6/8 | **75%** |

- **Fixed model:** `kit.gemma4-31b-it`.
- **Full retail is exploratory:** same optimized harness, all 115 upstream retail tasks — **not** a replacement for the N=25 claim.
- **Levers 1+2** (slot-backed mutation guard + host slot/soft-retry hardening) recovered **6/8** of the off-plan / noop / escalate / alternative-path fails they targeted.
- **Deferred:** lever 3 (world ID hints — recommended), lever 4 (finalize content gate — **rejected** as likely net-negative). Item/payment selection errors remain model-capability residuals (not gold-gated).

## Study framing

| Piece | Detail |
|---|---|
| Domain | τ-bench retail (`sierra-research/tau-bench` `tasks_test.py`) |
| Grade | `tau_policy`: DB hash vs gold mutating actions + required output substrings in `response` / `actions.jsonl` / `outputs.log` / `final.txt` |
| Claim set (frozen) | N=25 stride indices `0,4,…,96` — `instances/selection.json` + `manifest.yml` |
| Full set (curiosity) | N=115 — `instances/selection-full.json` + `manifest-full-retail.yml` |
| Harness | `cb-todo-delegate` pipeline: intake → worker → finalize |
| Importer | `scripts/import-tau-retail.mjs` (`--full --write-manifest`) |

Constraint unchanged: **harness / host / world only** — no model swap, no fine-tune, no gold kwargs/values in prompts (slot ids expose tool *names* / alternative-path unions only).

## Chronology

1. **N=25 v2 accepted** at 20/25 (80%) with 5 residual fails; soft-retry-without-reseed noted as known hole (`HRI-T-TODO-DELEGATE-REPORT.md`).
2. **Full retail import** of remaining 90 tasks; launch `hri-tau-todo-delegate-full-retail` (cb-todo-delegate only).
3. **Result:** 81/115 (70.4%); all fails `false_completion` / `gtp=false`.
4. **Fail taxonomy** → 4 clusters (off-plan mutations, weak kwargs gates, unreachable/double-seeded slots, output gaps).
5. **Kimi K3 proposal** → levers 1–2 implement; 3 recommend; 4 skip.
6. **Lever 1+2** land; smoke retry of 8 Cluster-A / alternative-path fails → 6/8 pass.

## Full retail results (`hri-tau-todo-delegate-full-retail`)

- **Wall:** ~2026-08-02T17:59Z → 2026-08-03T00:58Z (`EXIT:0`).
- **Engagement:** 115/115 scored; 0 infrastructure errors.
- **Headline:** **81/115 (70.4%)** task_success.
- **Artifacts:**  
  - Live: `live/reports/case-studies/tau-bench/hri-tau-todo-delegate-full-retail/`  
  - Summary: `case-studies/tau-bench/results/hri-tau-todo-delegate-full-retail.summary.json`

### Stride subset inside the full run (informal)

Of the original N=25 ids, full-run outcomes were **22/25** with fails **008, 064, 096**.  
This is **not** a claim re-score (different commit / harness state / single-rep noise vs `hri-tau-todo-delegate-v2`).

### FAIL list (34)

`002 005 006 007 008 010 013 019 025 027 039 045 046 047 049 057 059 062 063 064 066 071 074 079 082 083 091 093 096 099 101 105 108 110`

### Failure-mode taxonomy (pre–lever 1+2)

| Mode | n | Mechanism |
|---|---:|---|
| Wrong item set | ~9 | Right tool; wrong `item_ids` / `new_item_ids` |
| No successful mutate | ~7 | Gold needs DB change; agent never lands a successful mutate |
| Wrong payment method | ~5 | Right shape; wrong `payment_method_id` |
| Extra mutate after match | ~3 | Gold path then additional return/exchange |
| No-op gold but mutated | ~3 | Info-only / refuse gold (`[]` mutates); agent still cancels/returns |
| Mutations OK, outputs miss | ~2 | DB match; required substrings absent from grade blob |
| Incomplete tool set | ~2 | Multi-step; only partial |
| Should escalate | 1 | Gold `transfer_to_human_agents`; agent returned instead (`010`) |
| Wrong cancel reason | 1 | Right order; wrong `reason` (`066`) |
| Other kwargs | 1 | Address/item field diffs (`110`) |

**Dominant theme:** wrong/incomplete gold action set (or mutating when gold is empty) — not harness crashes.

## Levers 1+2 (implemented)

### Lever 1 — slot-backed mutation guard (`engines/ts/src/adapters/local.ts`)

- Before executing a mutating `tau.invoke`, read `tau/todos.json`.
- Allow mutate only if an **unfilled** `mutate_N_<tool>` (or `mutate_N_<a_or_b>`) slot lists that tool.
- Resolve/report-only plans: **block all mutating tools** (`error: off_plan_mutation`, `ok: 0`, no CLI side effect).
- After all mutate slots filled: further mutates blocked (stops extra-mutate class).
- `todo.complete` on `resolve_*`: deny if any successful mutating action exists (`resolve_requires_no_mutations`).
- `todo.complete` on `*_or_*` slots: accept either listed tool in `actions.jsonl`.

### Lever 2 — host hardening (`scripts/case-study-coding.mjs`)

| Change | Why |
|---|---|
| **Alternative-path dedupe** in `tauTodoSlots` | Gold often lists both `exchange_delivered_order_items` and `modify_pending_order_items` with identical kwargs; seeding both made one path unsatisfiable (e.g. exchange on pending). Now one `mutate_N_a_or_b` slot. |
| **Backfill by tool name** | Positional backfill could fill a transfer slot from a return action (masking `010`). |
| **Re-seed before worker soft-retry** | `applySeed` + clear `actions.jsonl` / logs + rewrite unfilled todos — closes the contamination hole called out in the N=25 report. |

Worker prompt updated to describe off-plan blocking and resolve-only discipline.

### Explicitly not done

- **No gold kwargs gate** at `todo.complete` (would leak answers / break HRI teachability claim).
- **No new `no_op` τ-world tool** — `resolve_*` slots are the no-op affordance; enforcement was the missing half.
- **Lever 3 / 4** — see below.

## Lever 1+2 validation (`hri-tau-todo-delegate-lever12-retry`)

Targeted 8 prior fails from Clusters A / alternative-path:

| Task | Prior class | Result |
|---|---|---|
| retail-005 | extra mutate | **PASS** |
| retail-010 | should escalate | **PASS** |
| retail-019 | wrong tool mix / items | FAIL (residual item selection) |
| retail-025 | noop gold, mutated | **PASS** |
| retail-027 | extra mutate | **PASS** |
| retail-057 | noop gold, mutated | **PASS** |
| retail-062 | noop gold, mutated | **PASS** |
| retail-064 | alternative-path + wrong variant | FAIL (or-slot worked via `modify`; wrong `new_item_ids` vs gold) |

**6/8 recovered.** Residuals are Cluster B (variant/item choice), not off-plan corruption.

- Live: `live/reports/case-studies/tau-bench/hri-tau-todo-delegate-lever12-retry/`
- Summary: `case-studies/tau-bench/results/hri-tau-todo-delegate-lever12-retry.summary.json`

## Levers 3 & 4 (decision)

| Lever | Intent | Decision |
|---|---|---|
| **3 — world ID hints** | Hint `#W…` order ids / numeric product ids on bad lookups (039/059-class loops) | **Recommended** — low risk, small upside, no gold leak |
| **4 — finalize content gate** | Deny `tau/final.txt` write until every filled report-slot value appears | **Skip** — grade already searches `outputs.log`; many passes have loose report slots; 096’s slots held wrong facts, so a gate would not invent gold amounts and can stall finalize |

## What we claim / do not claim

**Claim**

- On fixed Gemma, `cb-todo-delegate` achieves **81/115 (70.4%)** on full retail (curiosity run).
- Slot-plan enforcement + soft-retry re-seed are **sustainable** harness/host fixes: **6/8** targeted off-plan / noop / escalate fails flipped without gold leakage.
- Soft-retry contamination hole from the N=25 report is **closed** in code (re-seed path).

**Do not claim**

- That 70.4% is a new HRI headline replacing 80% N=25 (different selection, not a matched re-score).
- SOTA on τ-bench under any protocol.
- That item/payment selection fails are solved (they are not; gating them against gold would cheat).
- That lever 4 would improve utility (analysis says net-negative / low value).

## Artifacts & code map

### Runs

| Run id | Role |
|---|---|
| `hri-tau-todo-delegate-v2` | N=25 claim (80%) |
| `hri-tau-todo-delegate-full-retail` | Full 115 curiosity (70.4%) |
| `hri-tau-todo-delegate-lever12-retry` | Post–lever 1+2 smoke on 8 fails (6/8) |

### Code

| Path | Role |
|---|---|
| `case-studies/tau-bench/harnesses/cb-todo-delegate/` | Pipeline harness |
| `case-studies/tau-bench/manifest.yml` | N=25 matrix |
| `case-studies/tau-bench/manifest-full-retail.yml` | N=115 matrix |
| `case-studies/tau-bench/instances/selection.json` | N=25 selection |
| `case-studies/tau-bench/instances/selection-full.json` | N=115 selection |
| `scripts/import-tau-retail.mjs` | Import from `live/cache/tau/retail_tasks_test.json` |
| `scripts/case-study-coding.mjs` | Slot seed / backfill / soft-retry re-seed |
| `engines/ts/src/adapters/local.ts` | `tau.invoke` guard + `todo.complete` gates |
| `case-studies/tau-bench/world/tau.mjs` | Retail world / tools |

### Related report

- N=25 claim close-out: `case-studies/tau-bench/results/HRI-T-TODO-DELEGATE-REPORT.md`

## Follow-ups

1. **Lever 3:** world error ergonomics (`#` prefix / product id hints) — optional small patch + smoke `039`/`059`.
2. **Implement** `modify_pending_order_payment` (coverage / retail-040 class).
3. **Reject** empty `item_ids` / `new_item_ids` in CLI.
4. **Do not** gold-check item/payment at `todo.complete`.
5. Optional: full-115 **re-run** after lever 3 + payment tool if a post-hardening curiosity number is needed (still not a claim swap).

## Handoff

Track T harness story is stronger: claim N=25 at 80%, full-retail curiosity at 70.4%, and off-plan mutation class largely closed by levers 1+2. Residual utility gap is mostly **item/payment selection** under scripted user sims. Track S remains the parallel optimization focus unless a full-115 re-run is requested.
