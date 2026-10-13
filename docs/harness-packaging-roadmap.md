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
fausth verify <bundle.fausth.json>          # trust: FAUSTH_TRUSTED_KEYS, FAUSTH_REQUIRE_TRUSTED_BUNDLES
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
| Connectors without `mcp` / `module` | `fausth-harness-bundle/v0.2` | Source files + top-level `resolved` + `resolved_sha256` |
| Any `kind: mcp` or `kind: module` connector | `fausth-harness-bundle/v0.3` | v0.2 plus `connectors/mcp/*.json`, `connectors/module/*.(json\|yml\|yaml\|mjs)` and optional `mcp.recorded.jsonl` / `module.recorded.jsonl` |

v0.2 integrity (validated **before** any filesystem write):

- `resolved` must be `fausth-resolved-harness/v0.1`; `resolved_sha256` must match canonical hash
- Each file-connector lock path/hash must match the embedded `connectors/...` artifact
- **The embedded `resolved` must equal the re-resolution of the shipped sources.** The loader
  unpacks the files into a private temp dir, runs the normal resolver and compares hashes;
  a bundle whose `agent.yml` looks harmless while `resolved.agent` (which is what executes)
  says something else is rejected with `bundle_resolved_mismatch`. `resolved_sha256` is
  therefore checked against the sources, not only against the object it ships next to.
- Nested entries limited to `connectors.yml|yaml|json` and `connectors/<safe>.yml|yaml|json`
- Reject absolute/drive paths, backslashes, NULs, `..` / `.git`, names over 200 chars, unknown
  prefixes/extensions, unknown top-level fields, oversized files, lone UTF-16 surrogates, and
  non-integral / out-of-int53 JSON numbers (D3; integral floats such as `1.0` are ints)

v0.3 additionally allows `connectors/mcp/<safe>.json`, `connectors/module/<safe>.(json|yml|yaml|mjs)`
and top-level `mcp.recorded.jsonl` / `module.recorded.jsonl`, and verifies `kind: mcp` and
`kind: module` lock pins the same way as file connectors. The loader regex is kept identical to
[`schema/fausth-harness-bundle.v0.3.json`](../schema/fausth-harness-bundle.v0.3.json).

`pack` chooses the format automatically and runs the **loader's own validation** on the packed
object before writing it, so a pack can never emit an entry the loader rejects (recorded
fixtures are only added to v0.3 packs). `unpack` writes **source files only** (not the compiled
IR). Bundle `validate` / `resolve` / `inspect` / `test` / `run` use the verified embedded
resolved object as authoritative executable IR; an explicitly unpacked directory re-resolves
from restored source.

Lock pins (`sha256`) are computed over the **raw file bytes** in both engines (CRLF and a BOM
are preserved exactly; files must be valid UTF-8 — `connectors_invalid` otherwise), so CRLF
checkouts produce the same pins and byte-identical TS/Python packs.

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

`unpack` / `loadBundle` / `validateBundle` verify the signature when present and reject **before** filesystem writes. Missing signature remains allowed unless the trust policy requires one.

### Trust store and policy (EDGE-1)

A valid signature only proves "signed by the key embedded in the bundle" — anyone can sign.
Trust comes from an **operator trust store**: a text file with one 64-hex Ed25519 public key
per line, an optional label after whitespace, `#` comment lines and blank lines ignored; any
other line is an error (`bundle_trust_store_invalid`, fail closed — a missing file is an error,
not an empty store).

```text
# fausth trusted keys
3b6a27bc...e1c9  release-2026
```

Verification has **three distinct outcomes**: `unsigned` · `signed-untrusted` (valid signature,
key not in the store) · `signed-trusted` (valid signature, key in the store). A present but
invalid/tampered signature is never an outcome — it is always rejected (`bundle_signature_invalid`).

| Setting | Library option | Effect |
|---|---|---|
| `FAUSTH_TRUSTED_KEYS=<keys file>` | `trustedKeys` / `trusted_keys` | trust store used to classify signed bundles |
| `FAUSTH_REQUIRE_TRUSTED_BUNDLES=1` | `requireTrusted` / `require_trusted` | load/unpack/run accept **only** `signed-trusted` (`bundle_unsigned`, `bundle_signature_untrusted` otherwise) |

`verifyBundleFile()` (TS) / `verify_bundle_file()` (Py) return a report
`{ok, exit_code, path, format, status, public_key?, key_label?, require_trusted, error?}` and
`formatBundleVerifyReport()` / `format_bundle_verify_report()` render the same one-line text in
both engines. `fausth verify` exit codes:

| Exit | Meaning |
|---|---|
| `0` | accepted — `OK unsigned …`, `OK signed-untrusted …` or `OK signed-trusted …` |
| `1` | invalid bundle: tampered signature, broken integrity pins, `bundle_resolved_mismatch`, unreadable |
| `2` | trust-store configuration error (`bundle_trust_store_invalid`) |
| `3` | intact bundle rejected by the trust policy (`REJECTED …`) |

When a bundle is unpacked for `test` / `run`, the temp dir is registered with the adapter
provenance registry (`adapters/provenance.ts` / `fausth/provenance.py`) together with its trust
status, so host adapters can refuse to spawn commands declared by a deployment file that shipped
inside an unsigned or untrusted bundle.

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
- `kind: module` resolves offline from a locked `fausth-module-manifest/v0.1` (see M17) and packs as v0.3
- Schema: [`schema/fausth-mcp-descriptor.v0.1.json`](../schema/fausth-mcp-descriptor.v0.1.json)
- Example: [`examples/primitives/mcp-connectors/`](../examples/primitives/mcp-connectors/)
- Live stdio proof (toy server, recorded model): `node scripts/live-mcp-stdio.mjs`
- Live model + MCP: `node scripts/live-mcp-model.mjs` (`deployment.stdio-kit.yml` / `deployment.stdio-openrouter.yml`)

**Deferred (later PRs):** HTTP MCP, registries, Agent Skills loading, Reaction Trace, production isolation (see [`production-isolation.md`](production-isolation.md)).

## M12 — Output-surface verifies (shipped in `0.3.0-alpha`)

`kind: output` verifies on assistant/tool message content (`message.contains_code_fence`, …). Reason: `verify_output_failed`. Fixtures: `cb-chat-solution-absence-denied`, `cb-chat-absence-ok`.

## M13 — Memory provenance + TTL (shipped in `0.3.0-alpha`)

`invalidate_after.ttl_steps` + optional `memory_provenance`. Fixtures: `cb-stale-after-ttl`, `cb-memory-provenance-status`.

## M14 — `fausth audit` (shipped in `0.3.0-alpha`)

Deny-log sensor: aggregates `capability_missing`, structured `failure`, near-misses, `verify_output_failed`, `memory_stale`, `budget_exceeded`.

## M15 — Triggers + intervention budgets (shipped in `0.3.0-alpha`)

`intervention_budget` + declarative `triggers` (host interprets). Engine emits `budget_exceeded` record events for `window: run`. Demo: `scripts/intervention-host.mjs`.

## M16 — Mutable-cell self-editing (implemented)

`mutable: [skills|memory|instincts]`, tool `harness.propose_skills_patch`, runtime `rebalance` stage, `fausth select --candidate-patch`. Skills map to tool `description` only. Fixtures: `cb-harness-patch-*`. Example: `examples/mutable-skills/`.

### Selection gate (`fausth select`)

"Self-learning without gates is mutation without selection." Selection now runs the
**candidate** — it does not replay the fixtures' own `agent.json` against their goldens:

1. **Patch validation** (harness-patch op rules).
2. **Security cells, independently:** the before/after IR must be identical outside the mutable
   surfaces (tool `description`, `counterbalance.memory_notes`, `instinct_text`), and a mutable
   surface may change only if its cell is listed in `mutable`. Any change to permissions,
   filesystem scopes, protected paths, secrets, gates, limits, spawn, checkpoints, sequences, tool
   contracts or initial state rejects the candidate (`security_changes`).
3. **Fitness on recorded transcripts:** for every matching fixture, the *unpatched* harness
   (baseline) and the *patched* harness (candidate) both replay the fixture's recorded model
   transcript (`model.jsonl`, plus `tools.jsonl` when present). Outcome per run: the multiset of
   `deny` / `safe_state` verdicts (`verdict|stage|tool|reason`) and whether the declared
   completion tool executed with all verifies passing (D8). The candidate **fails a fixture** if it
   loses any deny/safe_state or the completion the baseline had, or stops following the
   transcript. Fixtures the baseline itself cannot replay are reported as not replayable and
   excluded. The result lists every fixture (`fixtures[]`, `fitness{…}`); each fixture's own golden
   is reported as `golden_ok` (corpus health, informational).

Honest scope: recorded transcripts are fixed model behaviour, so this gate proves **non-regression
of governed outcomes and unchanged security cells** — it cannot show that a description or memory
note improves a live model. `--skip-fixtures` and harnesses without matching fixtures are reported
as `fitness_evaluated: false` ("candidate NOT fitness-tested"); improvement claims need live
evaluation with holdouts (see [`evidence-pack.md`](evidence-pack.md)).

## M17 — `kind: module` connectors (subprocess)

Resolve/lock module connectors offline; execute via argv-allowlisted subprocess (MCP-like). No in-process JS/WASM in this milestone.

## M18 — Model-adaptive scaffolding overlays

Declarative per-model overlays that **narrow** (never widen) capability surfaces. Model remains a deployment concern.
