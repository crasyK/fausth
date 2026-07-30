# Changelog

## 0.2.0-alpha — Normative structured denies (contract v0.2)

### Added

- Normative [`docs/spec-v0.2.md`](docs/spec-v0.2.md) and [`schema/counterbalance-contract.v0.2.json`](schema/counterbalance-contract.v0.2.json).
- Structured deny signal `failure` on Counterbalance denies (`predicate` / `missing_prior_tools` / `checkpoint_key`), with optional checkpoint-derived `unblock`.
- `fs.list` read-only discovery tool; instructive shell allowlist errors.
- Case-study scoring: `discovery_failure`, `obsolete_surface_call`, floor/ceiling headline deltas.
- CLI contract-loop teaching on by default for live coding runs.

### Removed

- In-engine **modes** (`counterbalance.modes`, `mode.enter`, `mode_denied`, orientation `available_modes`).
  Capability limits come only from each harness YAML's tool list. Phased work uses separate
  subagent dirs; host code owns launch order.
- Fixture `cb-write-in-research-mode-denied` → `cb-write-not-provisioned` (`capability_missing`).
- Ad-hoc free-text `hint` on deny events (hosts may still render prose from `failure` for live models).

### Notes

- Normative contract is now **`counterbalance-contract/v0.2`**. v0.1 remains for pre-CB goldens.
- Unsigned coding `v0.1` pack size pin: **15411** bytes.
- Post-cut live baseline gate documented in [`docs/case-studies/PROTOCOL.md`](docs/case-studies/PROTOCOL.md) as `v0.4.0-baseline` (not run in this cut).

## 0.1.3-alpha — Portable connectors, signatures, MCP (M10–M11)

### Added

- Connector manifest + resolved harness IR (`fausth resolve`, `pnpm ci:resolve`).
- Portable resolved bundles: `fausth-harness-bundle/v0.2` (connectors) and `v0.3` (MCP descriptors).
- Optional Ed25519 detached bundle signatures (`fausth pack --sign-key`, `fausth verify`).
- MCP connectors (`kind: mcp`) with offline resolve and host transports `recorded` / `stdio`.
- Live proofs: `scripts/live-mcp-stdio.mjs` (process) and `scripts/live-mcp-model.mjs` (KIT/OpenRouter + MCP).
- Example harness: [`examples/primitives/mcp-connectors/`](examples/primitives/mcp-connectors/).
- Opt-in `limits.continue_after_deny` (default remains terminal deny for Track A goldens).
- Coding case-study live protocol v0.2: held-out grader, single-mode permissive control,
  outcome-based scorer, KIT 80-attempt matrix (`live-kit-v2`).

### Notes

- Legacy coding packs without connectors remain **byte-identical** `v0.1` (17022 bytes unsigned).
- `kind: module` is schema-recognized but fails closed until a later milestone.
- Normative contract remains **`counterbalance-contract/v0.1`**.
- Recorded case-study traces are plumbing regression only; live results are in
  [`examples/coding-counterbalance/VERIFICATION.md`](examples/coding-counterbalance/VERIFICATION.md).

## 0.1.2-alpha — Usable local coding harness (M8)

### Added

- Disposable-worktree-only local adapter (`local.fs_*`, `local.shell`, interactive and `*_auto` checkpoints).
- Path/scope enforcement (`sandbox-path`) rejecting primary checkout, traversal, `.git`, and escaping symlinks/junctions.
- Explicit `deployment.local-*.yml` for coding-counterbalance (never auto-selected by `test` / replay).
- Harness bundle schema `fausth-harness-bundle/v0.1`, safe unpack, and bundle-aware `validate` / `test` / `inspect` / `run`.
- `fausth unpack` (TS + Python) and TS↔Python byte-identical pack (`scripts/bundle-roundtrip.mjs`).
- `fausth run --workspace/--prompt/--task-file/--report/--expect-complete`.
- Track B report fields: `completion_reached`, `e2e_pass_rate` (separate from deny catch rate).
- Disposable worktree bootstrap/cleanup and recorded local e2e (`pnpm ci:local-e2e`).
- Authoring guide: [`docs/authoring.md`](docs/authoring.md).

### Notes

- Normative contract remains **`counterbalance-contract/v0.1`**. Bundle format is `v0.1`. Spec `v0.2` is still a non-normative draft.
- Real KIT/OpenRouter coding e2e in a disposable worktree is nightly/manual and secrets-gated.

## 0.1.1 — Baseline (M0–M7 + polish)

- Dual-runtime Track A conformance, Counterbalance bridge, support-bot world, binding registry, multi-host smoke, live Track B, nested spawn, packaging CLI.
- See [`docs/BASELINE-v0.1.md`](docs/BASELINE-v0.1.md) and tag `v0.1.1-baseline`.
