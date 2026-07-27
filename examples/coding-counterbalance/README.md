# Coding agent — Counterbalance vertical slice (v0.1 + counterbalance bridge)

Demonstrates ability (scoped write + test evidence), awareness (invalidate test evidence on write),
and behaviour (modes + plan-before-write sequence + todo completion gate).

Instincts (disposition; world enforces via `counterbalance`):
- research before plan
- plan approval before write
- re-test after edit before claiming completion

Track A fixtures: `cb-coding-happy-path`, `cb-write-before-plan-denied`,
`cb-stale-test-success`, `cb-completion-open-todos-denied`, `cb-write-in-research-mode-denied`.

```bash
pnpm -C engines/ts exec node --import tsx src/cli.ts validate ../../examples/coding-counterbalance
pnpm replay   # includes cb-* fixtures
```

See [`docs/counterbalance-architecture.md`](../../docs/counterbalance-architecture.md).
