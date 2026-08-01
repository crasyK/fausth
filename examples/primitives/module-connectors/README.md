# Module connectors example (M17)

`kind: module` resolves offline from a locked `fausth-module-manifest/v0.1`.

**Execution model:** subprocess only (same posture as MCP stdio). Resolve never executes the module.

Transports (deployment.module):

- `recorded` — Track A / CI via `module.recorded.jsonl`
- `stdio` — live toy server: `node connectors/module/echo-server.mjs`

```bash
pnpm -C engines/ts exec node --import tsx src/cli.ts resolve ../../examples/primitives/module-connectors
pnpm -C engines/ts exec node --import tsx src/cli.ts test ../../examples/primitives/module-connectors --skip-fixtures
pnpm -C engines/ts exec node --import tsx src/cli.ts pack ../../examples/primitives/module-connectors --out /tmp/module.fausth.json
```

Hash pins: set `sha256` on the connector entry; mismatch → `connectors_hash_mismatch`.
