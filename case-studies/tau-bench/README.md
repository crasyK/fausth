# τ-bench retail (HRI Track T)

Curated **N=25** retail tasks from [sierra-research/tau-bench](https://github.com/sierra-research/tau-bench) imported **1:1** (verbatim customer instructions + gold actions).

- Selection: [`instances/selection.json`](instances/selection.json)
- World: [`world/`](world/) (DB + `wiki.md` + `tau.mjs` API CLI)
- CB harness: wiki-before-write + `user.ask` before `tau` shell; PC is open twin
- Grade: `grade.kind: tau_policy` (DB hash vs gold actions)

```bash
node scripts/case-study-coding.mjs \
  --manifest case-studies/tau-bench/manifest.yml \
  --mode live --kit-models kit.gemma4-31b-it \
  --tasks retail-000 --reps 1 --run-id hri-tau-smoke-v1
```
