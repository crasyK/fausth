# Support bot — Counterbalance second world

Same exchange kernel as coding-counterbalance: skills + gates/sequences on a support world
(kb → answer, refund capability denied).

Track A fixtures: `cb-support-kb-then-answer`, `cb-support-answer-before-kb-denied`,
`cb-support-refund-capability-denied`.

```bash
pnpm -C engines/ts exec node --import tsx src/cli.ts validate ../../examples/support-bot
pnpm -C engines/ts exec node --import tsx src/cli.ts test ../../examples/support-bot
pnpm -C engines/ts exec node --import tsx src/cli.ts inspect ../../examples/support-bot

# Live (optional; needs OPENROUTER_API_KEY or KIT_AI_API_KEY)
pnpm -C engines/ts exec node --import tsx src/cli.ts live \
  --deployment ../../examples/support-bot/deployment.openrouter-free.yml \
  --scenarios ../../live/scenarios-support-bot \
  --report ../../live/reports/support-bot-openrouter.json \
  --catch-rate-min 0.5
```

See [`docs/counterbalance-architecture.md`](../../docs/counterbalance-architecture.md).
