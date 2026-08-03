# SWE-bench Lite (HRI Track S)

Curated **N=25** SWE-bench Lite instances imported **1:1** (verbatim `problem_statement`, `base_commit`, `FAIL_TO_PASS` / `PASS_TO_PASS`).

- Selection: [`instances/selection.json`](instances/selection.json)
- Import: `node scripts/import-swe-lite.mjs`
- Harnesses: CB pipeline + PC with whole-repo scopes (`"."`) and pytest allowlist
- Not a leaderboard claim — CB vs PC under Fausth only ([`docs/testing/HRI.md`](../../docs/testing/HRI.md))

```bash
# Smoke (1 task × 2 arms × 1 model × 1 rep)
node scripts/case-study-coding.mjs \
  --manifest case-studies/swe-bench/manifest.yml \
  --mode live --kit-models kit.gemma4-31b-it \
  --tasks pallets__flask-4045 --reps 1 --run-id hri-swe-smoke-v1

# Shard full slice
node scripts/kit-tmux-shard.mjs launch --level 2 \
  --manifest case-studies/swe-bench/manifest.yml \
  --run-id-prefix hri-swe-v1 --reps 1
```
