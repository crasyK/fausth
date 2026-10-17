# How-to recipes

Practical commands for 0.3.x. Normative rules: [`spec-v0.3.md`](spec-v0.3.md) (it overrides [`spec-v0.2.md`](spec-v0.2.md) and [`spec-v0.1.md`](spec-v0.1.md) where they conflict); authoring layout is in [authoring.md](authoring.md).

## Install

```bash +code
corepack enable
pnpm install
```

CLI (TypeScript):

```bash +code
pnpm fausth -- <command> …
# or
pnpm -C engines/ts exec node --import tsx src/cli.ts <command> …
```

CLI (Python):

```bash +code
cd engines/py
python -m fausth <command> …
```

## Validate, test, inspect

```bash +code
pnpm fausth -- validate examples/coding-counterbalance
pnpm fausth -- test examples/support-bot
pnpm fausth -- inspect examples/coding-counterbalance
```

`test` runs validate + bindings + smoke + related Track A fixtures. Prefer `deployment.fixture.yml` for Track A.

## Pack and unpack

```bash +code
pnpm fausth -- pack examples/coding-counterbalance --out live/reports/cb.fausth.json
pnpm fausth -- unpack live/reports/cb.fausth.json --out /tmp/cb --force
```

Format is chosen automatically:

| Harness | Bundle |
|---------|--------|
| No `connectors.yml` | `fausth-harness-bundle/v0.1` |
| Connectors, no MCP | `v0.2` |
| Any `kind: mcp` | `v0.3` |

Coding `v0.1` packs stay **byte-identical** when unsigned (the size is pinned in `engines/ts/src/bundle.test.ts`).

## Sign and verify

```bash +code
# 32-byte Ed25519 seed as hex
node -e "const {generateKeyPairSync}=require('crypto'); const k=generateKeyPairSync('ed25519').privateKey; process.stdout.write(k.export({type:'pkcs8',format:'der'}).subarray(-32).toString('hex'))" > seed.hex

pnpm fausth -- pack examples/primitives/inline-file-connectors --out live/reports/c.fausth.json --sign-key seed.hex
pnpm fausth -- verify live/reports/c.fausth.json
```

Or set `FAUSTH_SIGN_KEY=seed.hex`. Missing signature remains allowed; present signature is checked before unpack writes.

`fausth verify` prints one line and exits `0` (accepted), `1` (invalid / tampered), `2` (bad trust
store) or `3` (intact but rejected by trust policy). Trust and spawn policy flags work on every
command: `--trusted-keys <file>` (`FAUSTH_TRUSTED_KEYS`), `--require-trusted`
(`FAUSTH_REQUIRE_TRUSTED_BUNDLES=1`), `--allow-command <cmd>` (repeatable; `FAUSTH_ALLOW_COMMANDS`).

## Resolve connectors

```bash +code
pnpm fausth -- resolve examples/primitives/inline-file-connectors
pnpm fausth -- resolve examples/primitives/mcp-connectors --out live/reports/mcp.resolved.json
pnpm ci:resolve
```

Resolve is offline: it merges locked connector tools into `fausth-resolved-harness/v0.1`. MCP processes are not started at resolve time.

## MCP: recorded (CI) and live stdio

Recorded (default fixture deployment):

```bash +code
pnpm fausth -- test examples/primitives/mcp-connectors
pnpm fausth -- run examples/primitives/mcp-connectors --dump live/reports/mcp-recorded.jsonl
```

Live MCP process, recorded model:

```bash +code
node scripts/live-mcp-stdio.mjs
```

Live model + live MCP (needs `.env`):

```bash +code
cp .env.example .env   # set KIT_AI_API_KEY and/or OPENROUTER_API_KEY
node scripts/live-mcp-model.mjs          # prefer KIT, else OpenRouter
node scripts/live-mcp-model.mjs kit
node scripts/live-mcp-model.mjs openrouter
```

Deployments live under [`examples/primitives/mcp-connectors/`](../examples/primitives/mcp-connectors/).

## Local coding (disposable worktree)

```bash +code
pnpm ci:local-e2e
# live (secrets-gated):
node scripts/live-local-e2e.mjs
```

Never point `--workspace` at a valuable primary checkout.

## CI quality gate (SLOPATHON-style)

Local:

```bash +code
pnpm -C engines/ts exec node --import tsx src/cli.ts review --mode deterministic \
  --fixture ../../examples/slopathon-review/testdata/good-minimal
```

Land on an event repo: copy workflows from [`examples/slopathon-review/workflows/`](../examples/slopathon-review/workflows/), pin both `ref:` values to the same `crasyK/fausth` commit (prefer the [v0.1.3-alpha](https://github.com/crasyK/fausth/releases/tag/v0.1.3-alpha) tag SHA), add label `faust-review` and advisory secrets.

Details: [`ci-quality-gate.md`](ci-quality-gate.md) · [`examples/slopathon-review/`](../examples/slopathon-review/).

## CI scripts in this repo

```bash +code
pnpm ci:conformance   # tests + replay + TS↔Py parity
pnpm ci:multi-host
pnpm ci:packaging
pnpm ci:resolve
pnpm ci:local-e2e
pnpm ci:release-check
```

## Audit deny telemetry

Treat closed reason codes as a sensor (capability_missing, structured `failure`, output verifies):

```bash +code
pnpm fausth -- audit conformance/fixtures/cb-chat-solution-absence-denied/expected.jsonl
pnpm fausth -- audit live/reports/run.jsonl --json
```

Human summary counts denies, near-misses (a denied attempt of a tool immediately re-attempted and denied again in the same reaction), `verify_output_failed`, `memory_stale`, and `budget_exceeded`. Live `catch_rate` counts only pre-execution policy denies (spec-v0.3 §15.3).

## Intervention host (budget demo)

```bash +code
pnpm -C engines/ts exec node --import tsx ../../scripts/intervention-host.mjs --activations 2
```

Uses `conformance/fixtures/cb-budget-exceeded` — engine emits `budget_exceeded` on the run window; cron triggers remain host-declared.