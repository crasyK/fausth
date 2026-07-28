# Inline + file connector resolution (M10)

Minimal harness demonstrating the connector compile/link layer:

- `connectors.yml` declares an **inline** connector and a **file** connector
- `fausth resolve` merges selected provisions into canonical `ResolvedHarnessIR`
- `fausth run` and `fausth test` bind and execute the resolved tool set
- the inline temperature sensor and file-backed wait capability use existing deterministic `stub.*` natives
- `fausth pack` emits **`fausth-harness-bundle/v0.2`** with top-level `resolved` + `resolved_sha256`
- legacy manifest-less packs remain **byte-identical** `v0.1`

```bash +code
pnpm -C engines/ts exec node --import tsx src/cli.ts resolve ../../examples/primitives/inline-file-connectors
pnpm -C engines/ts exec node --import tsx src/cli.ts inspect ../../examples/primitives/inline-file-connectors
pnpm -C engines/ts exec node --import tsx src/cli.ts test ../../examples/primitives/inline-file-connectors
pnpm -C engines/ts exec node --import tsx src/cli.ts pack ../../examples/primitives/inline-file-connectors --out /tmp/connectors.fausth.json
pnpm -C engines/ts exec node --import tsx src/cli.ts run /tmp/connectors.fausth.json --dump /tmp/events.jsonl
python -m fausth test examples/primitives/inline-file-connectors
pnpm ci:resolve
pnpm ci:packaging
```

Deferred: module/MCP connectors, signatures, and registries.
