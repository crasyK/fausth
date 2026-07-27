# Support bot harness (Counterbalance — second single-agent world)

Same exchange kernel as coding: skills ↔ gates, memory ↔ user correction, instincts ↔ security.

Instincts (world-enforced):
- cite knowledge before policy answers (`answer.send` requires prior `kb.lookup`)
- no billing mutation (permission deny)
- escalate restricted domains via handoff

```bash
pnpm -C engines/ts exec node --import tsx src/cli.ts validate ../../examples/support-bot
pnpm replay  # includes cb-support-* fixtures
```
