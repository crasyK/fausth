# HACK//OPS · submission quality gate (example)

Case study for hosting a **two-layer submission review** in a hackathon repo (e.g. [SLOPATHON](https://github.com/HACK-OPS-KA/SLOPATHON)).

The **host** is GitHub Actions in the event repo. The **engine** is pinned from `crasyK/fausth` (`engines/ts`). This folder is the portable example — copy the workflows, tweak rules/label/deployment, keep human merge authority.

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

Design: [`docs/ci-quality-gate.md`](../../docs/ci-quality-gate.md) · matrix: [`VERIFICATION.md`](./VERIFICATION.md)

## Local

```bash
pnpm -C engines/ts exec node --import tsx src/cli.ts validate ../../examples/slopathon-review

pnpm -C engines/ts exec node --import tsx src/cli.ts review --mode deterministic \
  --fixture ../../examples/slopathon-review/testdata/good-minimal

pnpm -C engines/ts exec node --import tsx src/cli.ts review --mode advisory \
  --fixture ../../examples/slopathon-review/testdata/subtle-contradiction \
  --deployment ../../examples/slopathon-review/deployment.kit.yml
```

Against a real PR (`gh` auth):

```bash
pnpm -C engines/ts exec node --import tsx src/cli.ts review --mode deterministic \
  --repo HACK-OPS-KA/SLOPATHON --pr N --out review-out.json --post 1
```

`--post 1` writes the Checks **step summary**. Opt-in only: `--annotate 1`, `--check-run 1`, `--comment 1`.

## Land on a HACK//OPS event repo

1. Copy both `workflows/*.yml` into `.github/workflows/`.
2. Pin `ref:` to a `crasyK/fausth` commit SHA.
3. Add label `faust-review` and the advisory secret(s).
4. Adjust paths/rules in the engine contract / checker if the event layout differs from SLOPATHON `projects/`.

Never use `pull_request_target` with checkout/execution of contributor code while secrets are present.
