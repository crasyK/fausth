# Release notes — v0.3.0-alpha

Counterbalance control-timing land: **cannot / may not / did not**, plus the deny log as a sensor.

## What you can do

1. Author `kind: output` verifies so conversational agents cannot smuggle full solutions through chat when tools are already stripped.
2. Age evidence with `invalidate_after.ttl_steps` and optional `memory_provenance` status.
3. Run `fausth audit <events.jsonl>` to read deny telemetry (`capability_missing`, structured `failure`, near-misses).
4. Declare `intervention_budget` / `triggers`; hosts interpret schedules; engines emit `budget_exceeded` for run windows.

## Compatibility

| Surface | Version |
|---------|---------|
| Counterbalance contract (v0.3 candidates) | `v0.3` draft + fixtures |
| Counterbalance contract (normative CB bridge) | `v0.2` |
| Counterbalance contract (baseline goldens) | `v0.1` (immutable) |
| Harness bundle formats | `v0.1` · `v0.2` · `v0.3` |
| Package version | `0.3.0-alpha` |

## Docs

- [`docs/spec-v0.3-draft.md`](spec-v0.3-draft.md)
- [`docs/counterbalance-architecture.md`](counterbalance-architecture.md) (control timing, evidence independence, host-in-vessel)
- [`docs/self-improving-harnesses.md`](self-improving-harnesses.md) (design only)
- [`docs/notion-hub/`](notion-hub/) — publish to Notion when MCP is available

## Security disclaimer

Still **not** production isolation. MCP stdio is a real process. Bundle signatures are integrity, not a trust boundary.
