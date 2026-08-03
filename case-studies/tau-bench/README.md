# τ-bench retail (HRI Track T)

Retail tasks from [sierra-research/tau-bench](https://github.com/sierra-research/tau-bench) imported 1:1 (verbatim customer instructions + gold actions).

| Set | Manifest | Selection | Notes |
|-----|----------|-----------|-------|
| **N=25 claim** | [`manifest.yml`](manifest.yml) | [`instances/selection.json`](instances/selection.json) | Stride `0,4,…,96` — headline **80%** on `cb-todo-delegate` |
| **N=115 full** | [`manifest-full-retail.yml`](manifest-full-retail.yml) | [`instances/selection-full.json`](instances/selection-full.json) | Curiosity run — **70.4%** on same harness |

- World: [`world/`](world/) (DB + `wiki.md` + `tau.mjs`)
- Optimized harness: [`harnesses/cb-todo-delegate/`](harnesses/cb-todo-delegate/) (intake → worker → finalize)
- Import: `node scripts/import-tau-retail.mjs --full --write-manifest`
- Grade: `grade.kind: tau_policy` (DB hash vs gold actions + required outputs)

Reports:

- [`results/HRI-T-TODO-DELEGATE-REPORT.md`](results/HRI-T-TODO-DELEGATE-REPORT.md) — N=25 claim
- [`results/HRI-T-FULL-RETAIL-AND-LEVERS-REPORT.md`](results/HRI-T-FULL-RETAIL-AND-LEVERS-REPORT.md) — full retail + levers 1+2

```bash
# N=25 claim arm
node scripts/case-study-coding.mjs \
  --manifest case-studies/tau-bench/manifest.yml \
  --mode live --conditions cb-todo-delegate \
  --kit-models kit.gemma4-31b-it --reps 1 \
  --run-id hri-tau-todo-delegate-v2 --skip-conformance

# Full retail (curiosity)
node scripts/case-study-coding.mjs \
  --manifest case-studies/tau-bench/manifest-full-retail.yml \
  --mode live --conditions cb-todo-delegate \
  --kit-models kit.gemma4-31b-it --reps 1 \
  --run-id hri-tau-todo-delegate-full-retail --skip-conformance
```
