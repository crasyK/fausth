# Faust × SLOPATHON — CI quality gate (case study)

Reference **host integration** (not a third engine): GitHub Actions runs `engines/ts` to gate hackathon submissions.

## Layers

1. **Deterministic (blocking)** — structure, scope, README headings, template checkboxes, secret heuristics. No API keys.
2. **Advisory (label `faust-review`)** — Faust-bounded LLM review; findings must pass evidence verify. Secrets only in this job.

Human retains merge authority.

## Layout

| Path | Role |
|------|------|
| `agent.yml` | Counterbalance contract for advisory tools |
| `deployment.openrouter.yml` | Public demo models |
| `deployment.kit.yml` | KIT local models (`residency: kit-local`) |
| `workflows/*.yml` | Copy into target repo `.github/workflows/` |
| `testdata/*` | Synthetic packets for local CLI checks |

Design notes: [`docs/ci-quality-gate.md`](../../docs/ci-quality-gate.md).  
Verification matrix: [`VERIFICATION.md`](./VERIFICATION.md).

## Local commands

```bash
# Validate contract
pnpm -C engines/ts exec node --import tsx src/cli.ts validate ../../examples/slopathon-review

# Deterministic fixtures
pnpm -C engines/ts exec node --import tsx src/cli.ts review --mode deterministic \
  --fixture ../../examples/slopathon-review/testdata/good-minimal
pnpm -C engines/ts exec node --import tsx src/cli.ts review --mode deterministic \
  --fixture ../../examples/slopathon-review/testdata/bad-empty-readme
pnpm -C engines/ts exec node --import tsx src/cli.ts review --mode deterministic \
  --fixture ../../examples/slopathon-review/testdata/bad-scope

# Against a real PR (needs gh auth)
pnpm -C engines/ts exec node --import tsx src/cli.ts review --mode deterministic \
  --repo HACK-OPS-KA/SLOPATHON --pr 13 --out review-out.json

# Advisory (needs OPENROUTER_API_KEY or KIT_AI_API_KEY)
pnpm -C engines/ts exec node --import tsx src/cli.ts review --mode advisory \
  --fixture ../../examples/slopathon-review/testdata/bad-empty-readme \
  --deployment ../../examples/slopathon-review/deployment.openrouter.yml

# Force every pinned OpenRouter + KIT model once (writes live/reports/model-matrix/)
pnpm -C engines/ts exec node --import tsx src/run-model-matrix.ts

# Optional: post findings to Checks (default; no PR comment clutter)
pnpm -C engines/ts exec node --import tsx src/cli.ts review --mode deterministic \
  --repo OWNER/REPO --pr N --post 1
# Opt-in PR comment only if you really want it: add --comment 1
```

## Land in HACK-OPS-KA/SLOPATHON

1. Fork [HACK-OPS-KA/SLOPATHON](https://github.com/HACK-OPS-KA/SLOPATHON) (or open a PR from a branch with write access).
2. Copy:
   - `workflows/submission-deterministic.yml` → `.github/workflows/submission-deterministic.yml`
   - `workflows/submission-faust-review.yml` → `.github/workflows/submission-faust-review.yml`
3. Pin `crasyK/fausth` `ref:` to a commit SHA (not floating `main`) before production use.
4. For advisory only: add repo secret `OPENROUTER_API_KEY` (and/or `KIT_AI_API_KEY` + switch deployment).
5. Maintainers apply label **`faust-review`** to run Layer 2.
6. Open a PR describing the gate; link this README and `docs/ci-quality-gate.md`.

**Do not** use `pull_request_target` with checkout/execution of contributor code while secrets are present.

## Security reminders

- Deterministic job: no model secrets.
- Advisory job: Faust from trusted pin; PR content via API as inert data.
- Missing keys / rate limits → `infrastructure_error` / `neutral`, never silent pass.
