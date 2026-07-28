# Inline + file connector resolution (M10)

Minimal harness demonstrating the connector compile/link layer:

- `connectors.yml` declares an **inline** connector and a **file** connector
- `fausth resolve` merges selected provisions into canonical `ResolvedHarnessIR`
- `fausth run` and `fausth test` bind and execute the resolved tool set
- the inline temperature sensor and file-backed wait capability use existing deterministic `stub.*` natives
- bundle v0.1 remains unchanged

```bash +code
pnpm -C engines/ts exec node --import tsx src/cli.ts resolve ../../examples/primitives/inline-file-connectors
pnpm -C engines/ts exec node --import tsx src/cli.ts inspect ../../examples/primitives/inline-file-connectors
pnpm -C engines/ts exec node --import tsx src/cli.ts test ../../examples/primitives/inline-file-connectors
python -m fausth test examples/primitives/inline-file-connectors
pnpm ci:resolve
```

Deferred: module/MCP connectors and bundle v0.2 lock embedding.
