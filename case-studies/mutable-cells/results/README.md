# Mutable-cells case study results

Scaffolded from [`docs/case-studies/MUTABLE-CELLS-PROPOSAL.md`](../../docs/case-studies/MUTABLE-CELLS-PROPOSAL.md).

## One-shot non-inferiority (iid matrix)

Paired baseline vs `mutable-skills` on fresh harnesses each attempt.

```bash
node scripts/case-study-coding.mjs --manifest case-studies/mutable-cells/manifest.yml \
  --mode live --skip-conformance --reps 2 --kit-models kit.gemma4-31b-it \
  --run-id live-kit-mutable-mid-v4
```

| Run | Baseline | Mutable | Δ |
|-----|----------|---------|---|
| mid-v2 | 9/10 | 5/10 | −0.40 |
| mid-v3 (parity package) | 6/10 | 6/10 | 0 |
| mid-v4 (phase prompts + optional reflect) | 7/10 | 6/10 | −0.10 |

## Force-reflect probe (minimax)

`mutable-skills` (optional + host auto) vs `mutable-force-reflect` (required early reflect).

| Arm | Success | Research/plan disposition |
|-----|---------|---------------------------|
| mutable-skills | 8/8 | mostly `host_auto` |
| mutable-force-reflect | 7/8 | all `agent` decline |

Δ **−0.125** — Minimax can do forced early reflect, with a small success tax. Production path stays **locked host auto-decline** on research/plan (no reflect tool → no bypass).

## Frozen-twin curriculum (longitudinal)

```bash
node scripts/case-study-coding.mjs --manifest case-studies/mutable-cells/manifest.yml \
  --mode live --curriculum --reps 1 --kit-models kit.gemma4-31b-it \
  --skip-conformance --run-id live-kit-mutable-curriculum-v1
```

| Run | Baseline | Mutable | Δ | Notes |
|-----|----------|---------|---|-------|
| curriculum-v1 | 3/5 | 3/5 | 0 | early 2/3 vs 3/3; late 1/2 vs 0/2 — no late-task transfer win yet (n tiny) |

## Train → freeze → eval (minimax)

```bash
node scripts/case-study-coding.mjs --manifest case-studies/mutable-cells/manifest.yml \
  --mode live --train-freeze-eval --train-passes 2 \
  --shuffle-curriculum --curriculum-shuffle-seed 71 \
  --reps 1 --kit-models kit.minimax-m2.7-229b \
  --tasks 01-fix-add,02-add-multiply,03-fix-off-by-one,04-add-clamp,05-rename-greet,06-fix-null-guard,07-extract-sum,08-add-avg \
  --skip-conformance \
  --run-id live-kit-mutable-train-freeze-minimax-v1
```

| Run | Train p1 / p2 | Eval frozen | Eval baseline | Δ |
|-----|---------------|-------------|---------------|---|
| train-freeze-minimax-v1 | 8/8 / 8/8 | 8/8 | 8/8 | 0 |

## All-models locked host auto-decline

Aborted mid-run (`live-kit-mutable-autodecline-all-v1`): first Minimax attempt alone took ~5.6h wall / heavy token burn; 64-attempt matrix not practical on current KIT latency. Rely on gemma mid-v* + minimax train-freeze / force-reflect above until a cheaper matrix (recorded or 1×1 smoke) is viable.

```bash
node scripts/case-study-coding.mjs --manifest case-studies/mutable-cells/manifest.yml \
  --mode live --skip-conformance --reps 2 --kit-models all \
  --conditions baseline,mutable-skills \
  --tasks 01-fix-add,02-add-multiply,05-rename-greet,06-fix-null-guard \
  --run-id live-kit-mutable-autodecline-all-v1
```

Recorded matrix is deferred until plumbing traces exist under `recorded/`.
