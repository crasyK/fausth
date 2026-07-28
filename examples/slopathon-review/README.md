# HACK//OPS · submission quality gate (example)

Case study for hosting a **two-layer submission review** in a hackathon repo (e.g. [SLOPATHON](https://github.com/HACK-OPS-KA/SLOPATHON)).

The **host** is GitHub Actions in the event repo. The **engine** is pinned from `crasyK/fausth` (`engines/ts`). This folder is the portable example — copy the workflows, tweak rules/label/deployment, keep human merge authority.

## Status (2026-07-28)

| Item | State |
|------|-------|
| L1 deterministic + L2 advisory example | **Ready** in this repo |
| Verification matrix | **PASS** — see [`VERIFICATION.md`](./VERIFICATION.md) |
| Public SLOPATHON H1 sample (11 PRs) | **6 TP / 0 FP / 5 TN** on hard structural rules |
| Workflows pinned to Fausth | **`v0.1.3-alpha`** (`d7209b7…`) |
| Landed in `HACK-OPS-KA/SLOPATHON` workflows | **Yes** — [PR #25](https://github.com/HACK-OPS-KA/SLOPATHON/pull/25) (2026-07-28) |

Design: [`docs/ci-quality-gate.md`](../../docs/ci-quality-gate.md) · recipes: [`docs/HOW-TO.md`](../../docs/HOW-TO.md)

## Layers

| Layer | Trigger | Secrets | Role |
|-------|---------|---------|------|
| **L1 deterministic** | PR open/sync | none | Structure, scope, README headings, template boxes, secret heuristics |
| **L2 advisory** | label `faust-review` | `KIT_AI_API_KEY` and/or `OPENROUTER_API_KEY` | Soft issues (contradictions, unsafe demo advice); evidence-gated |

Findings show on the **Checks** job summary (one check per layer). No PR comment spam; no duplicate Check Runs.

Example workflows pin `crasyK/fausth` to a **commit SHA** (never floating `main`). After pulling updates into an event repo, bump both workflow `ref:` values together.

## Layout

| Path | Role |
|------|------|
| `agent.yml` | Counterbalance contract (advisory tools) |
| `deployment.kit.yml` | KIT local models |
| `deployment.openrouter.yml` | Public OpenRouter models |
| `workflows/submission-deterministic.yml` | L1 host workflow |
| `workflows/submission-faust-review.yml` | L2 host workflow |
| `testdata/*` | Local CLI fixtures |

## Local

```bash +code
pnpm -C engines/ts exec node --import tsx src/cli.ts validate ../../examples/slopathon-review

pnpm -C engines/ts exec node --import tsx src/cli.ts review --mode deterministic \
  --fixture ../../examples/slopathon-review/testdata/good-minimal

pnpm -C engines/ts exec node --import tsx src/cli.ts review --mode advisory \
  --fixture ../../examples/slopathon-review/testdata/subtle-contradiction \
  --deployment ../../examples/slopathon-review/deployment.kit.yml
```

Against a real PR (`gh` auth):

```bash +code
pnpm -C engines/ts exec node --import tsx src/cli.ts review --mode deterministic \
  --repo HACK-OPS-KA/SLOPATHON --pr N --out review-out.json --post 1
```

`--post 1` writes the Checks **step summary**. Opt-in only: `--annotate 1`, `--check-run 1`, `--comment 1`.

## Land on a HACK//OPS event repo

1. Copy both `workflows/*.yml` into `.github/workflows/`.
2. Pin `ref:` to a `crasyK/fausth` commit SHA (start from tag `v0.1.3-alpha`).
3. Add label `faust-review` and the advisory secret(s).
4. Adjust paths/rules in the engine contract / checker if the event layout differs from SLOPATHON `projects/`.

After bumping the pinned `ref` SHA, run `pnpm ci:release-check` in the Fausth repo to confirm both L1 and L2 workflows are aligned to the same commit.

Never use `pull_request_target` with checkout/execution of contributor code while secrets are present.
