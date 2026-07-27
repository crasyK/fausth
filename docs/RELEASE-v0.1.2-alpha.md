# Release notes — v0.1.2-alpha

Fausth’s first **usable local coding harness** alpha: simulation-backed Track A stays sacred; real FS/process I/O is opt-in inside linked disposable git worktrees; harnesses round-trip as `.fausth.json` bundles.

## What you can do

1. Author a harness (`agent.yml` + deployments) — see [`docs/authoring.md`](docs/authoring.md).
2. `validate` → `test` → `inspect` → `pack` → `unpack` / `run`.
3. Run recorded coding completion inside a disposable worktree (`pnpm ci:local-e2e`).
4. Optionally run live KIT/OpenRouter against `deployment.local-*.yml` with `--workspace` (secrets required).

## Compatibility

| Surface | Version |
|---------|---------|
| Counterbalance contract (normative) | `v0.1` |
| Harness bundle format | `fausth-harness-bundle/v0.1` |
| Package version | `0.1.2-alpha` |
| Spec v0.2 draft | Non-normative — do not treat as shipped |

## Security disclaimer

This alpha is **not** production isolation. Containment is worktree + allowlisted argv + scope checks. Do not point `--workspace` at valuable checkouts. Do not treat deny catch rates as a substitute for threat modeling.

## Artifacts

- Example packs: `live/reports/*.fausth.json`
- Recorded local e2e report: `live/reports/local-e2e.json`
- Live reports (secrets-gated): `live/reports/live-local-e2e-*.json`
