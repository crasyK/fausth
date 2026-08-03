# Ambiguous-intent support harness: must user.ask before answer.send.

See fixtures:
- conformance/fixtures/cb-ask-before-act-denied
- conformance/fixtures/cb-ask-before-act-ok

```bash
pnpm -C engines/ts exec node --import tsx src/cli.ts test ../../examples/support-bot-ask
pnpm -C engines/ts exec node --import tsx src/cli.ts live \
  --deployment ../../examples/support-bot/deployment.kit.yml \
  --scenarios ../../live/scenarios-support-ask \
  --report ../../live/reports/support-ask-kit.json \
  --catch-rate-min 0.5
```
