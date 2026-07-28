# Release notes — v0.1.3-alpha

Portable packaging stack for connector harnesses: resolved IR bundles, optional Ed25519 signatures, and MCP connectors with recorded + live stdio transports — proven with live KIT/OpenRouter models.

## What you can do

1. Author connector harnesses (`connectors.yml`) and `fausth resolve` into `fausth-resolved-harness/v0.1`.
2. `pack` → automatic bundle format (`v0.1` / `v0.2` / `v0.3`); optional `--sign-key` + `fausth verify`.
3. Declare `kind: mcp` tools via locked descriptors; bind with `deployment.mcp` (`recorded` or `stdio`).
4. Prove live stdio MCP (`node scripts/live-mcp-stdio.mjs`) and live model + MCP (`node scripts/live-mcp-model.mjs`).

## Compatibility

| Surface | Version |
|---------|---------|
| Counterbalance contract (normative) | `v0.1` |
| Harness bundle formats | `fausth-harness-bundle/v0.1` · `v0.2` · `v0.3` |
| Connector / resolved IR | `fausth-connectors/v0.1` · `fausth-resolved-harness/v0.1` |
| MCP descriptor | `fausth-mcp-descriptor/v0.1` |
| Package version | `0.1.3-alpha` |
| Spec v0.2 draft | Non-normative — do not treat as shipped |

## Security disclaimer

This alpha is **not** production isolation. MCP `stdio` spawns a real process (not a sandbox). Bundle signatures are opt-in integrity, not a trust boundary for untrusted authors. Do not point `--workspace` at valuable checkouts.

## Artifacts

- Example: [`examples/primitives/mcp-connectors/`](../examples/primitives/mcp-connectors/)
- Live reports: `live/reports/live-mcp-stdio.json`, `live/reports/live-mcp-model-*.json`
- CI: `pnpm ci:resolve`, `pnpm ci:packaging`
