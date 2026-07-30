# Release notes — v0.2.0-alpha

Normative Counterbalance contract **v0.2**: structured deny signals (`failure`) on completion, sequence, and checkpoint denies; modes removed; discovery and scoring hardened for the coding case study.

## What you can do

1. Rely on machine-checkable `failure` objects in event logs when Counterbalance denies fire (no opaque `completion_gate_failed` alone).
2. Author checkpoints with `allow_set_keys` so engines can attach `unblock` remediation hints for `eq` predicates.
3. Use `fs.list` for scoped discovery instead of inventing shell explore commands.
4. Keep packing / resolving / MCP flows from 0.1.3-alpha unchanged.

## Compatibility

| Surface | Version |
|---------|---------|
| Counterbalance contract (normative) | `v0.2` |
| Counterbalance contract (v0.1 baseline goldens) | `v0.1` (immutable) |
| Harness bundle formats | `fausth-harness-bundle/v0.1` · `v0.2` · `v0.3` |
| Connector / resolved IR | `fausth-connectors/v0.1` · `fausth-resolved-harness/v0.1` |
| MCP descriptor | `fausth-mcp-descriptor/v0.1` |
| Package version | `0.2.0-alpha` |

## Security disclaimer

This alpha is **not** production isolation. MCP `stdio` spawns a real process (not a sandbox). Bundle signatures are opt-in integrity, not a trust boundary for untrusted authors. Do not point `--workspace` at valuable checkouts.

## Artifacts

- Spec: [`docs/spec-v0.2.md`](spec-v0.2.md)
- Schema: [`schema/counterbalance-contract.v0.2.json`](../schema/counterbalance-contract.v0.2.json)
- Authoring: [`docs/authoring.md`](authoring.md) (structured deny section)
- Case-study canary: `case-studies/coding-counterbalance/results/live-kit-v3-gemma-probe-structured.summary.json`
- CI: `pnpm ci:conformance`, `pnpm ci:packaging`, `node scripts/release-check.mjs`
