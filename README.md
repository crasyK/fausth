# Faust Harness (`fausth`)

Portable runtime and standard for **agent harnesses**: give an agent skills, memory, and instincts; define the gates, user checkpoints, and security that keep them true; run the same harness locally, in CI, on a server, or in simulation.

**Counterbalance:** agent and world counterweight each other across **ability**, **awareness**, and **behaviour**. The model proposes; Fausth governs the exchange. See [`docs/counterbalance-architecture.md`](docs/counterbalance-architecture.md).

**Status:** v0.1.3-alpha research alpha — portable connector packs, signatures, and MCP stdio. Normative contract remains `counterbalance-contract/v0.1`. Not production-safe.

## Two MVP claims

1. **Deterministic (Track A):** The same contract produces **byte-identical** event logs on TypeScript and Python when replaying golden fixtures (including verification verdicts).
2. **Live (Track B):** Against **OpenRouter free models**, the same gates + verify stages catch unsafe/incorrect tool use — measured by `fausth live` reports.

Claim 1 never depends on live models. Claim 2 never pollutes claim 1.

## What v0.1.3-alpha proves

| Claim | Status |
|-------|--------|
| One contract interpreted by two runtimes | Proven (Track A) |
| Deterministic gates + verify replay | Proven |
| Tool input/output schema enforcement | Proven |
| Governed effect observation | Proven |
| Verified recovery / compensation path | Proven (fixtures) |
| Tighten-only spawn lattice (tools, fs, limits) | Proven (fixtures) |
| Model transports swappable independently | Proven (adapters) |
| Memory freshness / sequence enforcement (Counterbalance slice) | Proven (Track A `cb-*` fixtures) |
| Multi-host (TS / Python / GHA) same harness + bindings | Proven (`pnpm ci:multi-host`) |
| Live coding-counterbalance (OpenRouter Track B) | Secrets-gated (`live-openrouter` + CB scenarios) |
| Nested spawn child log (M6) | Proven (Track A `spawn-nested-*`) |
| Packaging CLI (`validate`/`test`/`inspect`/`pack`/`unpack`/`run`/`verify`) | Proven (`pnpm ci:packaging`) |
| Disposable-worktree local FS/process adapter (M8) | Proven (`pnpm ci:local-e2e`) |
| Bundle TS↔Python byte-identical pack | Proven (`scripts/bundle-roundtrip.mjs`) |
| Connector resolve + resolved IR execution (M10) | Proven (`pnpm ci:resolve`) |
| Portable resolved bundles v0.2 / MCP bundles v0.3 | Proven (`scripts/bundle-roundtrip.mjs`) |
| Optional Ed25519 bundle signatures (M10.4) | Proven (`scripts/bundle-signature-roundtrip.mjs`) |
| MCP connectors recorded + live stdio (M11) | Proven (`scripts/mcp-execution.mjs`, `live-mcp-stdio.mjs`) |
| Live model + live MCP (KIT / OpenRouter) | Proven (`scripts/live-mcp-model.mjs`) |
| Model-adaptive scaffolding | **Not yet** |
| Production-ready isolation / security | **Not yet** |

## Headline: `verify`

Pre-execution deny gates are table stakes. Faust declares **how the world proves the action worked** (`effect`, `evidence`, `absence`; live-only `judge`), and can run **verified recovery** when the world disagrees.

## Reference surface: CI quality gate

[`examples/slopathon-review/`](examples/slopathon-review/) hosts Faust in GitHub Actions as a layered PR gate. That is a **reference harness / portability proof**, not the definition of Fausth. See [`docs/ci-quality-gate.md`](docs/ci-quality-gate.md).

## Model transport

Primary integration is **OpenAI-compatible Chat Completions** with provider profiles (`openrouter`, `ollama`, `kit-scc`, `generic`). See [`docs/openai-compatible.md`](docs/openai-compatible.md). Secrets use `api_key_env` only — never YAML literals.

```bash +code
# Public free-model demo
pnpm live -- --deployment examples/greenhouse/deployment.openrouter-free.yml

# Institutional KIT gateway (requires KIT_AI_API_KEY)
pnpm -C engines/ts exec node --import tsx src/cli.ts provider probe \
  --deployment ../../examples/greenhouse/deployment.kit.yml
```

## Quickstart (first harness path)

```bash +code
corepack enable
pnpm install
pnpm test
pnpm replay
pnpm ci:multi-host   # same coding-counterbalance harness: TS ≡ Python ≡ golden
pnpm ci:packaging    # validate + test + pack + TS↔Py bundle bytes
pnpm ci:local-e2e    # recorded completion in a disposable linked worktree
pnpm fausth -- help
```

Author / check a harness (see [`docs/authoring.md`](docs/authoring.md)):

```bash +code
pnpm fausth -- validate examples/coding-counterbalance
pnpm fausth -- test examples/support-bot
pnpm fausth -- inspect examples/coding-counterbalance
pnpm fausth -- pack examples/coding-counterbalance --out live/reports/out.fausth.json
pnpm fausth -- unpack live/reports/out.fausth.json --out /tmp/cb --force
pnpm ci:resolve        # connector + MCP resolve/execution parity
node scripts/live-mcp-stdio.mjs   # live MCP process (no API key)
# node scripts/live-mcp-model.mjs # live model + MCP (needs .env keys)
```

### Security boundaries (alpha)

- Real I/O only with an explicit `deployment.local-*.yml` and `--workspace` = linked disposable worktree.
- Not a VM sandbox. Do not use on valuable primary checkouts.
- Track A goldens never depend on live models or local writes.

Prove the harness with free models (needs `OPENROUTER_API_KEY` — see `.env.example`):

```bash +code
cp .env.example .env   # add your key
pnpm live
```

Primary OpenAI-compatible integration:

```bash +code
# Public free-model demo
pnpm live -- --deployment examples/greenhouse/deployment.openrouter-free.yml

# Institutional KIT gateway (requires KIT_AI_API_KEY)
pnpm -C engines/ts exec node --import tsx src/cli.ts provider probe \
  --deployment ../../examples/greenhouse/deployment.kit.yml
```

## Spec

Normative prose: [`docs/spec-v0.1.md`](docs/spec-v0.1.md).  
Architecture: [`docs/architecture.md`](docs/architecture.md) · [`docs/glossary.md`](docs/glossary.md).  
Counterbalance draft: [`docs/counterbalance-architecture.md`](docs/counterbalance-architecture.md).

## License

Apache-2.0 — see `LICENSE` and `NOTICE`.

## Repository

https://github.com/crasyK/fausth
