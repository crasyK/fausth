# Kaggriculture — watchlist (deferred)

**Status:** Deferred · **Revisit:** after chess procedural stability gate  
**Competition:** [Kaggle Kaggriculture](https://www.kaggle.com/competitions/kaggriculture/overview)

## Why deferred

1. **Framing mismatch:** Competition is RL/simulation optimization (fast `agent(obs)` loop, 720 turns, 1s/action budget) — not an LLM-in-the-loop agent harness flagship.
2. **No episode-time network:** Rules §2.12 forbid ingress/egress during evaluation → live LLM API calls impossible on leaderboard.
3. **Resource envelope:** 1.6 vCPU, 6.5 GiB RAM, no GPU, 100 MiB submission — no room for bundled LLM weights.
4. **Current priority:** Chess wind tunnel proves game-world adapter + procedural gates first.

## What recon found (2026-08-03)

| Item | Detail |
|------|--------|
| Timeline | Jul 29 – Sep 30 2026 submission; entry Sep 23 |
| Evaluation | Bradley-Terry tournament; final bank balance |
| Seeds | Optional `seed` in config; replay JSON downloadable |
| LLM in dev | Allowed under “Reasonableness Standard” for training/distillation |
| Starter agents | `pass`, `random`, `starter` in kaggle-environments |

## What would make it worth revisiting

- Chess gate passed and shared `GameWorld` interface documented.
- Clear Fausth story: **offline** LLM strategy search → distilled deterministic agent.
- Local baselines beat `starter` across fixed seeds before any submission talk.

## Fausth fit (if revived)

| Mode | Fit |
|------|-----|
| Live LLM on leaderboard | **No** |
| Local LLM development loop + distillation | **Maybe** |
| Local case study only (no submission) | **Yes** |

## First commands (future agent)

```bash
pip install -U kaggle-environments
python -c "from kaggle_environments import make; e=make('kaggriculture'); print(e.spec)"
# Read env: kaggle_environments/envs/kaggriculture/
```

## Evidence if pursued later

Follow [`../../evidence-pack.md`](../../evidence-pack.md). Do not count recorded plumbing as live observations.

## Related

- Strategy handoff: `/DATA/myfiles/fausth-strategy-handoff-report.md`
- Chess gate: [`../../../case-studies/chess/results/PROCEDURAL-RELIABILITY.md`](../../../case-studies/chess/results/PROCEDURAL-RELIABILITY.md)
