# MCP connectors (M11)

Minimal harness demonstrating `kind: mcp` connectors:

- `connectors.yml` declares an MCP connector with a locked JSON descriptor
- `fausth resolve` merges selected tools into `ResolvedHarnessIR` offline (no MCP process)
- `deployment.fixture.yml` binds `get_forecast` to `mcp.weather.get_forecast` with **recorded** transport
- `fausth pack` emits **`fausth-harness-bundle/v0.3`**
- `kind: module` remains unsupported (deferred)

```bash +code
pnpm -C engines/ts exec node --import tsx src/cli.ts resolve ../../examples/primitives/mcp-connectors
pnpm -C engines/ts exec node --import tsx src/cli.ts test ../../examples/primitives/mcp-connectors
pnpm -C engines/ts exec node --import tsx src/cli.ts pack ../../examples/primitives/mcp-connectors --out /tmp/mcp.fausth.json
pnpm -C engines/ts exec node --import tsx src/cli.ts run /tmp/mcp.fausth.json --dump /tmp/events.jsonl
python -m fausth test examples/primitives/mcp-connectors
pnpm ci:resolve
```

Live stdio MCP is opt-in via `deployment.mcp.<server>.transport: stdio` with `command`/`args` (not a sandbox). Relative `args` resolve from the harness directory.

```bash +code
# Live process proof (toy weather MCP server; recorded model)
node scripts/live-mcp-stdio.mjs

# Live model + live MCP (requires KIT_AI_API_KEY or OPENROUTER_API_KEY in .env)
node scripts/live-mcp-model.mjs          # prefer KIT, else OpenRouter
node scripts/live-mcp-model.mjs kit
node scripts/live-mcp-model.mjs openrouter
```
