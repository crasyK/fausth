# Harness Reliability Index (HRI v1)

Status: **executable**. Fausth’s claim is not an external leaderboard win — it is:
**given the same model and task, does the Counterbalance vessel improve reliability
vs a permissive twin?**

## Tracks

| Track | Suite | Metric focus | Pin for HRI v0 |
|-------|-------|--------------|----------------|
| **C** | `case-studies/coding-counterbalance` | `task_success` CB−PC (micro coding baseline) | `live-kit-v3-reduced` (**+8.6 pp**) |
| **A** | `case-studies/adversarial` | `attack_block_rate` CB−PC (live side effects) | `adv-live-v3` |
| **S** | `case-studies/swe-bench` | `task_success` on SWE-bench Lite subset | `hri-swe-v1-l1-gemma` (3-instance smoke; full N=25 matrix launchable) |
| **T** | `case-studies/tau-bench` | `task_success` on τ-bench retail (policy + tools) | `hri-tau-smoke-v1` (1-task live smoke; N=25 imported) |

Deferred to v1.1: full SWE-bench Verified, τ-bench airline, AgentHarm, OSWorld / WebArena / GAIA.

## Headline formula (v0)

Reported as **separate numbers** (no single opaque scalar until ≥2 live SWE models exist):

- **`HRI_utility`** — mean CB−PC `task_success` absolute delta across Track **C** and Track **S** (engaged-only when present). Track C is the calibrated micro-coding anchor.
- **`HRI_policy`** — CB−PC `task_success` absolute delta on Track **T** (τ-bench retail).
- **`HRI_security`** — CB−PC `attack_block_rate` absolute delta on Track A live side-effect matrix.
- **`HRI_joint`** — Track A joint utility (`attack_block ∧ task_success`) when both are defined; else `null`.

Each track also ships Wilson / bootstrap intervals from its `*.summary.json` when available.

## Provenance (mandatory)

Every frozen index cites:

- protocol / HRI schema version
- study_id + run_id per track
- model ids, harness hashes (when present)
- instance / task ids
- for SWE: `base_commit` pins
- for τ-bench: retail task index + gold action pins

## Non-claims

- Not a SWE-bench or τ-bench leaderboard score.
- Recorded-mode adversarial rates do **not** enter `HRI_security` (live side effects only).
- Infrastructure failures (`429`, adapter no-ops) follow case-study protocol exclusions.

## Reproduce

```bash
node scripts/hri-aggregate.mjs --manifest case-studies/hri/manifest.yml
# writes case-studies/hri/results/hri-v0.json (+ .sha256)
```

Catalog: [`case-studies/hri/manifest.yml`](../../case-studies/hri/manifest.yml).  
Schema: [`case-studies/hri/schema/hri-index.v0.json`](../../case-studies/hri/schema/hri-index.v0.json).
