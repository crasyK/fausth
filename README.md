# Faust Harness (`fausth`)

Portable **Counterbalance Contract** runtime: define an agent once, enforce gates and **post-execution verification**, swap the model.

## Two MVP claims

1. **Deterministic (Track A):** The same contract produces **byte-identical** event logs on TypeScript and Python when replaying golden fixtures (including verification verdicts).
2. **Live (Track B):** Against **OpenRouter free models**, the same gates + verify stages catch unsafe/incorrect tool use — measured by `fausth live` reports.

Claim 1 never depends on live models. Claim 2 never pollutes claim 1.

## Headline: `verify`

Pre-execution deny gates are table stakes. Faust declares **how the world proves the action worked** (`effect`, `evidence`, `absence`; live-only `judge`).

## Quickstart

```bash
corepack enable
pnpm install
pnpm test
pnpm replay
```

Validate an example:

```bash
pnpm exec fausth validate examples/greenhouse
```

Prove the harness with free models (needs `OPENROUTER_API_KEY` — see `.env.example`):

```bash
cp .env.example .env   # add your key
pnpm live -- --deployment examples/greenhouse/deployment.openrouter-free.yml \
  --scenarios live/scenarios --report live/reports/out.json
```

## Spec

Normative prose: [`docs/spec-v0.1.md`](docs/spec-v0.1.md).  
Theory / Counterbalance Architecture: [My Harness Engineering Journey](https://www.notion.so/My-Harness-Engineering-Journey-36d7c4b5883280ab9480d1f85d816ef3).

## License

Apache-2.0 — see `LICENSE` and `NOTICE`.

## Repository

https://github.com/crasyK/fausth
