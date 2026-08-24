# Chess case study

Procedural wind tunnel for Fausth game-world mechanics. Validates legality gates, stale-state rejection, deterministic replay, and terminal claims — **not** chess playing strength.

Research program (H0–H6, Stockfish ruler, position suite): [`RESEARCH-PROGRAM.md`](RESEARCH-PROGRAM.md).

## Quick start

```bash
# Track A fixtures (no API keys)
pnpm chess:fixtures
pnpm replay   # all chess-* should PASS

# Two-model match (KIT — needs KIT_AI_API_KEY)
pnpm chess:match

# Harness validate + bindings
pnpm fausth test ../../case-studies/chess/harnesses/legality-gated
pnpm fausth test ../../case-studies/chess/harnesses/permissive-control
pnpm fausth test ../../case-studies/chess/harnesses/oriented

# Unit tests
pnpm -C engines/ts test
```

## Layout

```
case-studies/chess/
  manifest.yml
  RESEARCH-PROGRAM.md   # H0–H6 + measurement phases
  series/               # episode format (YouTube / devlog)
  harnesses/
    legality-gated/     # H1 primary — sequences + verify (live series)
    permissive-control/ # H0 control — no sequence gates
    oriented/           # H2 gated + orientation emit
  deployments/
  tasks/start-position/
  expected/scoring.yml
  results/
    PROCEDURAL-RELIABILITY.md
    SERIES-REPORT.md
    claim.yml
    residuals.json
    PROVENANCE.md
  README.md
  RUNBOOK.md
  ADAPTER.md
```

## Evidence

Convention: [`docs/evidence-pack.md`](../../docs/evidence-pack.md).

- Track A: [`results/claim.yml`](results/claim.yml) · [`results/PROCEDURAL-RELIABILITY.md`](results/PROCEDURAL-RELIABILITY.md)
- Track B live series: [`results/SERIES-REPORT.md`](results/SERIES-REPORT.md) (16/20 games; gates held; infra/protocol dominated outcomes)
- Raw traces (gitignored): `live/reports/chess-series/`

## Handoff

| Doc | Purpose |
|-----|---------|
| [ADAPTER.md](ADAPTER.md) | Tool contract, state machine, stale/illegal semantics |
| [RUNBOOK.md](RUNBOOK.md) | Commands, traps, extension points |
| [RESEARCH-PROGRAM.md](RESEARCH-PROGRAM.md) | What to build next (ruler first) |
| [series/README.md](series/README.md) | Episode format |
| [results/PROCEDURAL-RELIABILITY.md](results/PROCEDURAL-RELIABILITY.md) | Track A stability gate |
| [results/SERIES-REPORT.md](results/SERIES-REPORT.md) | Live two-model series |

## Related

- World catalog: [`worlds/chess/`](../../worlds/chess/)
- Docs map: [`docs/README.md`](../../docs/README.md)
- Track S freeze: [`../swe-bench/results/FREEZE.md`](../swe-bench/results/FREEZE.md)
- Kaggriculture deferred: [`../../docs/archive/recon/kaggriculture.md`](../../docs/archive/recon/kaggriculture.md)
