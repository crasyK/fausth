# Faust Harness (`fausth`)

Portable **Counterbalance Contract** runtime: define an agent once, enforce gates and **post-execution verification**, swap the model.

**Status:** v0.1.1 research alpha — correctness-focused. Not production-safe.

## Two MVP claims

1. **Deterministic (Track A):** The same contract produces **byte-identical** event logs on TypeScript and Python when replaying golden fixtures (including verification verdicts).
2. **Live (Track B):** Against **OpenRouter free models**, the same gates + verify stages catch unsafe/incorrect tool use — measured by `fausth live` reports.

Claim 1 never depends on live models. Claim 2 never pollutes claim 1.

## What v0.1.1 proves

| Claim | Status |
|-------|--------|
| One contract interpreted by two runtimes | Proven (Track A) |
| Deterministic gates + verify replay | Proven |
| Tool input/output schema enforcement | Proven |
| Governed effect observation | Proven |
| Verified recovery / compensation path | Proven (fixtures) |
| Tighten-only spawn lattice (tools, fs, limits) | Proven (fixtures) |
| Model transports swappable independently | Proven (adapters) |
| Model-adaptive scaffolding | **Not yet** |
| Production-ready isolation / security | **Not yet** |

## Headline: `verify`

Pre-execution deny gates are table stakes. Faust declares **how the world proves the action worked** (`effect`, `evidence`, `absence`; live-only `judge`), and can run **verified recovery** when the world disagrees.

## Product surface: CI quality gate

First external case study: Faust as a **layered PR quality gate** (deterministic blocking + evidence-verified advisory LLM), hosted by GitHub Actions — not a third engine.

See [`docs/ci-quality-gate.md`](docs/ci-quality-gate.md) and [`examples/slopathon-review/`](examples/slopathon-review/) (SLOPATHON).

## Model transport

Primary integration is **OpenAI-compatible Chat Completions** with provider profiles (`openrouter`, `ollama`, `kit-scc`, `generic`). See [`docs/openai-compatible.md`](docs/openai-compatible.md). Secrets use `api_key_env` only — never YAML literals.

```bash
# Public free-model demo
pnpm live -- --deployment examples/greenhouse/deployment.openrouter-free.yml

# Institutional KIT gateway (requires KIT_AI_API_KEY)
pnpm -C engines/ts exec node --import tsx src/cli.ts provider probe \
  --deployment ../../examples/greenhouse/deployment.kit.yml
```

## Quickstart

```bash
corepack enable
pnpm install
pnpm test
pnpm replay
```

Validate an example:

```bash
pnpm -C engines/ts exec node --import tsx src/cli.ts validate ../../examples/greenhouse
```

Prove the harness with free models (needs `OPENROUTER_API_KEY` — see `.env.example`):

```bash
cp .env.example .env   # add your key
pnpm live
```

## Spec

Normative prose: [`docs/spec-v0.1.md`](docs/spec-v0.1.md).  
Theory / Counterbalance Architecture: [My Harness Engineering Journey](https://www.notion.so/My-Harness-Engineering-Journey-36d7c4b5883280ab9480d1f85d816ef3).

## License

Apache-2.0 — see `LICENSE` and `NOTICE`.

## Repository

https://github.com/crasyK/fausth
