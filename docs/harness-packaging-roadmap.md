# Fausth packaging and multi-host (status)

M4–M7 of the plan of record are **shipped**. This page is the operator map; normative rules stay in [`spec-v0.1.md`](spec-v0.1.md).

## M4 — Simulation and adapter compatibility

- [`engines/ts/src/adapters/simulation.ts`](../engines/ts/src/adapters/simulation.ts) — in-memory coding world
- Adapter failure (`binding_missing` / `adapter_unresolved`) ≠ harness authorize deny
- `fausth test <harness>` runs validate + bindings + smoke + related Track A fixtures

## M5 — Multi-host

Same [`examples/coding-counterbalance/`](../examples/coding-counterbalance/) harness on:

1. Local TypeScript (`fausth run`)
2. Python (`python -m fausth run`)
3. GitHub Actions ([`multi-host.yml`](../.github/workflows/multi-host.yml))

### M5.1 — Live models (Track B)

| Deployment | Env |
|---|---|
| `deployment.openrouter-free.yml` | `OPENROUTER_API_KEY` |
| `deployment.kit.yml` | `KIT_AI_API_KEY` |
| `deployment.openai.yml` | `OPENAI_API_KEY` (optional) |

Support-bot has the same OpenRouter/KIT pattern under [`examples/support-bot/`](../examples/support-bot/).

**Deferred:** browser / WASM host; HTTP Python live transport; production multi-tenant isolation.

## M6 — Multi-agent

Nested reaction when spawn args include `proposals`. Child events use `depth` / `spawn_id`. Fixtures: `spawn-nested-ok`, `spawn-nested-deny`, `spawn-child-escalate-deny`.

## M7 — Packaging

```bash +code
fausth validate <harness|bundle>
fausth test <harness|bundle> [--deployment <file>] [--skip-fixtures]
fausth inspect <harness|bundle>
fausth pack <harness> [--out <path|dir>]
fausth unpack <bundle.fausth.json> --out <dir> [--force]
fausth run <harness|bundle> --deployment <deployment>
```

```bash +code
pnpm ci:packaging
pnpm ci:multi-host
```

Share via git tags / release archives before any registry.

## M8 — Usable local coding harness (shipped in `0.1.2-alpha`)

- Linked disposable worktree adapter: [`engines/ts/src/adapters/local.ts`](../engines/ts/src/adapters/local.ts)
- Bundle schema + round-trip: [`schema/fausth-harness-bundle.v0.1.json`](../schema/fausth-harness-bundle.v0.1.json)
- Authoring: [`docs/authoring.md`](authoring.md)
- Recorded e2e: `pnpm ci:local-e2e`
- Live disposable e2e: `node scripts/live-local-e2e.mjs` (secrets-gated, non-blocking on rate limits)

## M10 — Connector manifest and resolved IR (in progress)

Additive compile/link layer. Normative runtime remains `counterbalance-contract/v0.1`.

```bash +code
fausth resolve <harness|bundle> [--out <resolved.json>]
pnpm ci:resolve
```

- Sidecar [`connectors.yml`](../examples/primitives/inline-file-connectors/connectors.yml) (`inline` + `file` kinds)
- Canonical `fausth-resolved-harness/v0.1` with integrity lock metadata
- Identity passthrough for harnesses without connectors
- Schemas: [`schema/fausth-connectors.v0.1.json`](../schema/fausth-connectors.v0.1.json), [`schema/fausth-resolved-harness.v0.1.json`](../schema/fausth-resolved-harness.v0.1.json)

**Deferred (later PRs):** `module`/`mcp` connectors, runtime consumption of resolved IR, bundle v0.2 lock embedding, Agent Skills loading, memory ports, Reaction Trace, `fausth audit`.
