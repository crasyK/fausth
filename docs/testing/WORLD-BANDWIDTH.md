# World-bandwidth ablation (P4)

Same coding gates; two orientation/observation budgets.

| Variant | Path | World talks |
|---------|------|-------------|
| terse | `examples/coding-bandwidth-terse/` | `orientation.emit_each_step: false` |
| verbose | `examples/coding-bandwidth-verbose/` | `orientation.emit_each_step: true` + richer tool descriptions |

## Claim under test

At fixed safety (same scopes / sequences / completion), does **more vessel bandwidth** raise held-out task success?

## How to run (recorded smoke)

```bash
pnpm -C engines/ts exec node --import tsx src/cli.ts test ../../examples/coding-bandwidth-terse --skip-fixtures
pnpm -C engines/ts exec node --import tsx src/cli.ts test ../../examples/coding-bandwidth-verbose --skip-fixtures
```

## Live paired pilot (tmux)

Use coding-counterbalance tasks with two harness roots (or overlay) once wired into a manifest.
Until a dedicated live matrix freezes, Track A / packaging smoke is the bandwidth gate; results go in `docs/testing/STRESS-TEST-REPORT.md`.
