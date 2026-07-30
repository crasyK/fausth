# Coding agent — Counterbalance vertical slice

Demonstrates **subagent capability provisioning**:

| Agent | Tools (only these) |
|-------|--------------------|
| [`agents/research`](agents/research) | `fs.read`, `user.correct`, `phase.yield` |
| [`agents/plan`](agents/plan) | `fs.read`, `user.approve`, `user.correct`, `phase.yield` |
| [`agents/implementation`](agents/implementation) | read/write/shell/`task.complete` + evidence gates |

The host launches each agent; Faust only enforces the active YAML.
There is no in-YAML `modes` register anywhere — capability provisioning is the only scoping mechanism.

Instincts (enforced by structure + gates):
- research before plan (separate harness)
- plan approval before implementation (host check + no write tool earlier)
- re-test after edit before claiming completion (`invalidate_after` + completion require)

Track A fixtures: `cb-coding-happy-path`, `cb-write-before-plan-denied`,
`cb-stale-test-success`, `cb-completion-open-todos-denied`, `cb-write-not-provisioned`.

## Multi-host (M5)

Root `agent.yml` remains for recorded multi-host smoke. Prefer the `agents/` dirs for live work:

```bash
pnpm -C engines/ts exec node --import tsx src/cli.ts run ../../examples/coding-counterbalance/agents/research \
  --deployment ../../case-studies/coding-counterbalance/deployments/local-kit.yml \
  --workspace /path/to/worktree
```

### Case-study matrix

```bash
node scripts/case-study-coding.mjs --mode live --run-id live-kit-smoke-v3 --limit 8
```

Default live models: Gemma + Minimax (see `manifest.yml` `live_kit_models`).
