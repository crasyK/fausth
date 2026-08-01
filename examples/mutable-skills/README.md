# Mutable skills example

Minimal harness demonstrating `mutable: [skills]` and `harness.propose_skills_patch`.

Track A: `cb-harness-patch-*` fixtures.

```bash
pnpm -C engines/ts exec node --import tsx src/cli.ts validate ../../examples/mutable-skills
pnpm -C engines/ts exec node --import tsx src/cli.ts select ../../examples/mutable-skills --candidate-patch patch-skills.json --skip-fixtures
pnpm -C engines/ts exec node --import tsx src/cli.ts pack ../../examples/mutable-skills --out /tmp/mutable-skills.fausth.json
```

Security and checkpoints are never patchable — see `docs/self-improving-harnesses.md`.
