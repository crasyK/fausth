# Examples library

Harnesses used for CI smoke, HOW-TO recipes, and demos. Case-study *science* lives under `case-studies/`, not here.

```bash
pnpm ci:library-smoke    # fausth test --skip-fixtures on the wired set
```

## Wired into `ci:library-smoke`

| Path | Why it exists |
|------|----------------|
| `coding-counterbalance/` | Primary coding vertical slice |
| `support-bot/` · `support-bot-ask/` | Policy sequences + `user.ask` |
| `coding-bandwidth-terse/` · `coding-bandwidth-verbose/` | Orientation bandwidth ablation |
| `greenhouse/` | Effect / budget verify |
| `mutable-skills/` | M16 skills-patch demo |
| `case-studies/chess/harnesses/*` | Chess H0/H1/H2 (research world) |

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
