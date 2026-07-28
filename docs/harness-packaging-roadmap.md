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
fausth pack <harness> [--out <path|dir>] [--sign-key <seed.hex|pem>]
fausth unpack <bundle.fausth.json> --out <dir> [--force]
fausth verify <bundle.fausth.json>
fausth run <harness|bundle> --deployment <deployment>
```

```bash +code
pnpm ci:packaging
pnpm ci:multi-host
```

Share via git tags / release archives before any registry.

## M8 — Usable local coding harness (shipped in `0.1.2-alpha`)

- Linked disposable worktree adapter: [`engines/ts/src/adapters/local.ts`](../engines/ts/src/adapters/local.ts)
- Bundle schema + round-trip: [`schema/fausth-harness-bundle.v0.1.json`](../schema/fausth-harness-bundle.v0.1.json) (legacy) and [`schema/fausth-harness-bundle.v0.2.json`](../schema/fausth-harness-bundle.v0.2.json) (connector harnesses)
- Authoring: [`docs/authoring.md`](authoring.md)
- Recorded e2e: `pnpm ci:local-e2e`
- Live disposable e2e: `node scripts/live-local-e2e.mjs` (secrets-gated, non-blocking on rate limits)

## M10 — Connector manifest and resolved IR

Additive compile/link layer. Normative runtime remains `counterbalance-contract/v0.1`.

```bash +code
fausth resolve <harness|bundle> [--out <resolved.json>]
pnpm ci:resolve
pnpm ci:packaging
```

- Sidecar [`connectors.yml`](../examples/primitives/inline-file-connectors/connectors.yml) (`inline` + `file` kinds)
- Canonical `fausth-resolved-harness/v0.1` with integrity lock metadata
- Identity passthrough for harnesses without connectors
- `run`, `test`, smoke execution, and binding coverage consume `ResolvedHarnessIR.agent`
- Connector execution parity: TS ↔ Python ↔ recorded expected log (directory **and** packed v0.2 bundle)
- Schemas: [`schema/fausth-connectors.v0.1.json`](../schema/fausth-connectors.v0.1.json), [`schema/fausth-resolved-harness.v0.1.json`](../schema/fausth-resolved-harness.v0.1.json)

### Bundle format policy (M10.3)

| Harness | Bundle format | Notes |
|---------|---------------|-------|
| No `connectors.yml` | `fausth-harness-bundle/v0.1` | Flat allowlist; **byte-identical** to pre-M10.3 packs |
| Connectors without `mcp` | `fausth-harness-bundle/v0.2` | Source files + top-level `resolved` + `resolved_sha256` |
| Any `kind: mcp` connector | `fausth-harness-bundle/v0.3` | v0.2 plus `connectors/mcp/*.json` and optional `mcp.recorded.jsonl` |

v0.2 integrity (validated **before** any filesystem write):

- `resolved` must be `fausth-resolved-harness/v0.1`; `resolved_sha256` must match canonical hash
- Each file-connector lock path/hash must match the embedded `connectors/...` artifact
- Nested entries limited to `connectors.yml|yaml|json` and `connectors/<safe>.yml|yaml|json`
- Reject absolute/drive paths, backslashes, NULs, `..` / `.git`, unknown prefixes/extensions, oversized files

v0.3 additionally allows `connectors/mcp/<safe>.json` and top-level `mcp.recorded.jsonl`, and verifies `kind: mcp` lock pins the same way as file connectors.

`pack` chooses the format automatically. `unpack` writes **source files only** (not the compiled IR). Bundle `validate` / `resolve` / `inspect` / `test` / `run` use the verified embedded resolved object as authoritative executable IR; an explicitly unpacked directory re-resolves from restored source.

### Bundle signatures (M10.4)

Optional Ed25519 detached signatures (opt-in; default pack remains unsigned so coding v0.1 packs stay **byte-identical**).

| Field | Value |
|-------|--------|
| `signature.alg` | `ed25519` only (unknown alg → hard fail) |
| `signature.public_key` | 32-byte raw public key, lowercase hex |
| `signature.sig` | 64-byte detached signature, lowercase hex |
| Covered bytes | UTF-8 of `canonicalJson` of the bundle **without** `signature` (v0.2: `format`/`name`/`files`/`resolved`/`resolved_sha256`; v0.1: `format`/`name`/`files`) |

```bash +code
# 32-byte seed as hex (or PKCS8 PEM)
node -e "const {generateKeyPairSync}=require('crypto'); const k=generateKeyPairSync('ed25519').privateKey; process.stdout.write(k.export({type:'pkcs8',format:'der'}).subarray(-32).toString('hex'))" > seed.hex

fausth pack examples/primitives/inline-file-connectors --out dist/c.fausth.json --sign-key seed.hex
# or: FAUSTH_SIGN_KEY=seed.hex fausth pack ...
fausth verify dist/c.fausth.json
```

`unpack` / `loadBundle` / `validateBundle` verify the signature when present and reject **before** filesystem writes. Missing signature remains allowed.

## M11 — MCP connectors (module stubbed)

```bash +code
fausth resolve examples/primitives/mcp-connectors
fausth test examples/primitives/mcp-connectors
fausth pack examples/primitives/mcp-connectors --out dist/mcp.fausth.json
pnpm ci:resolve
```

- `kind: mcp` connectors declare tool contracts via locked `connectors/mcp/*.json` descriptors (`fausth-mcp-descriptor/v0.1`)
- Resolve stays **offline / non-executing**; deployment owns transport:
  - `recorded` — Track A / CI via `mcp.recorded.jsonl`
  - `stdio` — live MCP server process (`command` + `args`; not a sandbox)
- Natives: `mcp.<serverId>.<toolId>` (toolId must match harness tool id)
- `kind: module` is schema-recognized but resolve fails closed (`connectors_unsupported`)
- Schema: [`schema/fausth-mcp-descriptor.v0.1.json`](../schema/fausth-mcp-descriptor.v0.1.json)
- Example: [`examples/primitives/mcp-connectors/`](../examples/primitives/mcp-connectors/)
- Live stdio proof (toy server, recorded model): `node scripts/live-mcp-stdio.mjs`
- Live model + MCP: `node scripts/live-mcp-model.mjs` (`deployment.stdio-kit.yml` / `deployment.stdio-openrouter.yml`)

**Deferred (later PRs):** real `module` plugins, HTTP MCP, registries, Agent Skills loading, memory ports, Reaction Trace, `fausth audit`.
