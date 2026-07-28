# Inline + file connector resolution (M10)

Minimal harness demonstrating the connector compile/link layer:

- `connectors.yml` declares an **inline** connector and a **file** connector
- `fausth resolve` merges selected provisions into canonical `ResolvedHarnessIR`
- Runtime, deployments, and bundles are unchanged in this milestone

```bash +code
pnpm -C engines/ts exec node --import tsx src/cli.ts resolve ../../examples/primitives/inline-file-connectors
pnpm -C engines/ts exec node --import tsx src/cli.ts inspect ../../examples/primitives/inline-file-connectors
```

Deferred: module/MCP connectors, runtime wiring of resolved IR, and bundle v0.2 lock embedding.
