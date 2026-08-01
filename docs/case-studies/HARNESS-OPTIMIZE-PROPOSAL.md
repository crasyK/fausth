# Case study proposal: S/T harness optimization parallel arms

Status: **executable pilot** — Phase-0 S unblock (`.` scope fix + plan approve-before-yield) + four CB arms vs baseline.

## Claim (bounded)

On fixed Gemma (`kit.gemma4-31b-it`) and fixed Track S / Track T task subsets, **each** harness change applied once to baseline CB is scored independently:

| Condition | Single change | Harness lifecycle | Tries / task |
|-----------|---------------|-------------------|--------------|
| `counterbalanced` | Baseline (post Phase-0) | Static | 1 |
| `cb-budget` | Higher limits + one soft plan retry | Static | 1 |
| `cb-mutable` | End-of-phase / end-of-attempt `reflect_skills` | **Never reset** lineage | ≤5 until success |
| `cb-optimize` | Post-fail optimizer digest → skills patch | **Never reset** lineage | ≤5 until success |

Primary metric: paired `task_success` Δ vs baseline on identical task ids (adaptive arms: **any-of-≤5** plus first-try rate). Security / sequences / tool schemas stay immutable (`fausth select` skills-only).

This does **not** stack the three ideas into one harness. Combining winners is a later study.

## Never-reset + five tries

Adaptive arms keep one lineage per `(track, condition, model, rep)` for the whole task order. Accepted patches stick across intra-task retries and across tasks. Stock YAML is never reloaded mid-arm.

## Tracking (mandatory)

Every try is a ledger row with `try_index`, `parent_attempt_id`, `task_chain_id`, IR/security hashes, disposition, `selection_ok`, `optimize_triggered`. Append-only `lineage/history.jsonl`. Post-run `ATTRIBUTION.md` + invariant check (`never_reset_violations == 0`).

## Reproduce

```bash
# One arm per detached tmux session (8 parallel — KIT N=8)
node scripts/opt-arms-tmux.mjs launch

node scripts/opt-arms-tmux.mjs status
```

Manifests: [`case-studies/swe-bench/manifest-optimize.yml`](../../case-studies/swe-bench/manifest-optimize.yml), [`case-studies/tau-bench/manifest-optimize.yml`](../../case-studies/tau-bench/manifest-optimize.yml).

## Success criteria (pre-register)

- Per-arm any-of-≤5 Δ vs baseline reported; pilot “signal” threshold ≥ +2/8 absolute
- `security_intact_rate == 1`, `never_reset_violations == 0`
- Mutable: reflection disposition on every completed try
- Do not overwrite frozen `hri-gemma-full` bundle
