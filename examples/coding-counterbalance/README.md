# Coding agent — Counterbalance vertical slice (v0.1 + counterbalance bridge)

Demonstrates ability (scoped write + test evidence), awareness (invalidate test evidence on write),
and behaviour (modes + plan-before-write sequence + todo completion gate).

Instincts (disposition; world enforces via `counterbalance`):
- research before plan
- plan approval before write
- re-test after edit before claiming completion

Track A fixtures: `cb-coding-happy-path`, `cb-write-before-plan-denied`,
`cb-stale-test-success`, `cb-completion-open-todos-denied`, `cb-write-in-research-mode-denied`.

## Multi-host (M5)

Same harness + `deployment.fixture.yml` / `deployment.simulation.yml` bindings:

```bash +code
# Local TypeScript (recorded smoke)
pnpm -C engines/ts exec node --import tsx src/cli.ts run ../../examples/coding-counterbalance \
  --deployment ../../examples/coding-counterbalance/deployment.fixture.yml

# Python host (same recorded proposals)
python -m fausth run examples/coding-counterbalance \
  --deployment examples/coding-counterbalance/deployment.fixture.yml

# Compare TS ≡ Python ≡ golden (also run in CI via multi-host.yml)
pnpm ci:multi-host
```

Missing or unknown `bindings.*.native` values fail as **adapter** errors (`binding_missing` / `adapter_unresolved`), not harness authorize denies.

### Live models (M5.1)

Same harness; swap deployment for the key you have:

```bash +code
# OpenRouter (OPENROUTER_API_KEY)
pnpm -C engines/ts exec node --import tsx src/cli.ts live \
  --deployment ../../examples/coding-counterbalance/deployment.openrouter-free.yml \
  --scenarios ../../live/scenarios-coding-counterbalance \
  --report ../../live/reports/coding-counterbalance-openrouter.json \
  --catch-rate-min 0.5

# KIT (KIT_AI_API_KEY)
pnpm -C engines/ts exec node --import tsx src/cli.ts live \
  --deployment ../../examples/coding-counterbalance/deployment.kit.yml \
  --scenarios ../../live/scenarios-coding-counterbalance \
  --report ../../live/reports/coding-counterbalance-kit.json \
  --catch-rate-min 0.5
```

## Local disposable worktree (M8)

`deployment.local-*.yml` is **never** auto-selected by `test` / replay. Requires `--workspace` = linked disposable git worktree.

```bash +code
pnpm ci:local-e2e   # recorded happy path (CI-safe)

# Live (secrets):
node scripts/live-local-e2e.mjs local-openrouter
node scripts/live-local-e2e.mjs local-kit
```

```bash +code
pnpm -C engines/ts exec node --import tsx src/cli.ts validate ../../examples/coding-counterbalance
pnpm replay   # includes cb-* fixtures
```

See [`docs/authoring.md`](../../docs/authoring.md), [`docs/counterbalance-architecture.md`](../../docs/counterbalance-architecture.md), and [`docs/harness-packaging-roadmap.md`](../../docs/harness-packaging-roadmap.md).
