# Examples library

Harnesses used for CI smoke, HOW-TO recipes, and demos. Case-study *science* lives under `case-studies/`, not here.

```bash
pnpm ci:library-smoke    # fausth test --skip-fixtures on the wired set
```

## Wired into `ci:library-smoke`

| Path | Why it exists |
|------|----------------|
| `coding-counterbalance/` | Primary coding vertical slice (smoke: write before plan approval is denied) |
| `support-bot/` · `support-bot-ask/` | Policy sequences; `support-bot-ask` asks the user through a recorded user channel (`user.answers.jsonl`, D14) |
| `coding-bandwidth-terse/` · `coding-bandwidth-verbose/` | Orientation bandwidth ablation |
| `greenhouse/` | Effect verify (governed observation) + gates (smoke: fan 40 verified, fan 90 gate-denied); recovery is covered by the `verify-effect-mismatch` fixture |
| `mutable-skills/` | Skills-patch demo (smoke: `harness.propose_skills_patch` → `rebalance`) |

User-channel tools (`channel: user`) are bound in deployments with `user: {source: recorded|simulator|human}`
(docs/spec-v0.3.md §9). Fixture deployments of packed examples leave them unbound (calls are denied with
`capability_missing`), `deployment.local-fixture.yml` uses recorded answers, KIT deployments use a
`kit.glm-5.3-flash` simulator, other live deployments ask a human. Harness memory semantics (tests passing,
plan approval, phase yield, …) are declared as tool `effects` in each `agent.yml`, and the model's system
context is the harness's `instinct_text` (§15.3).

## Wired elsewhere in CI (not library-smoke)

| Path | Used by |
|------|---------|
| `primitives/inline-file-connectors/` | bundle / resolve / connector-execution |
| `primitives/mcp-connectors/` | MCP recorded + live stdio scripts |
| `slopathon-review/` | `scripts/release-check.mjs` pin extraction |

## Keep, but treat as historical / manual

| Path | Notes |
|------|-------|
| `coding/` | Legacy single-agent coding; `gen-fixtures.ts` + `live/scenarios/` still point here. Prefer `coding-counterbalance/`. |
| `coding-mutable-skills/` · `coding-mutable-skills-force-reflect/` | Used by `case-studies/mutable-cells/` only |
| `primitives/module-connectors/` | Documented `kind: module` example; no `scripts/*.mjs` hook |

Do not add new research claims under `examples/`. New worlds go in `case-studies/` + `worlds/`.
