# Authoring a Fausth harness

This guide covers the first portable harness path: author → validate → test → inspect → pack → run.

For copy-paste recipes (sign, resolve, MCP live, CI gate), see [`HOW-TO.md`](HOW-TO.md).

## Harness layout

```bash +code
examples/my-harness/
  agent.yml                 # Counterbalance agent IR (required)
  connectors.yml            # optional M10 connector manifest (inline + file + mcp)
  connectors/               # optional file-connector imports referenced by the lock
  connectors/mcp/           # optional MCP descriptors (kind: mcp)
  servers/                  # optional local MCP stdio servers for live demos
  deployment.fixture.yml    # recorded / Track A bindings (preferred for test)
  deployment.stdio*.yml     # optional live MCP stdio (+ optional live model)
  deployment.simulation.yml # optional sim.* natives
  deployment.kit.yml        # live model (optional)
  deployment.local-*.yml    # real FS/process — explicit-only, never auto-picked
  mcp.recorded.jsonl        # optional recorded MCP tool responses
  smoke.model.jsonl         # optional recorded proposals
  smoke.expected.jsonl      # optional golden events for smoke
  README.md
```

### Bundle formats

| Format | When | Schema |
|--------|------|--------|
| `fausth-harness-bundle/v0.1` | Manifest-less harnesses | [`schema/fausth-harness-bundle.v0.1.json`](../schema/fausth-harness-bundle.v0.1.json) |
| `fausth-harness-bundle/v0.2` | Harnesses with `connectors.yml` (no mcp) | [`schema/fausth-harness-bundle.v0.2.json`](../schema/fausth-harness-bundle.v0.2.json) |
| `fausth-harness-bundle/v0.3` | Harnesses with `kind: mcp` connectors | [`schema/fausth-harness-bundle.v0.3.json`](../schema/fausth-harness-bundle.v0.3.json) |

v0.2/v0.3 embed top-level `resolved` (`fausth-resolved-harness/v0.1`) and `resolved_sha256`. `unpack` restores source files only; bundle execution uses the verified embedded IR. See [`harness-packaging-roadmap.md`](harness-packaging-roadmap.md) §M10.3 / §M11.

Optional Ed25519 signatures (`signature.alg` / `public_key` / `sig`) are opt-in at pack time (`--sign-key` or `FAUSTH_SIGN_KEY`). Unsigned packs stay byte-identical. When present, `unpack` / `validate` / `fausth verify` check the signature before any filesystem write. See §M10.4 in the packaging roadmap.

## Agent IR essentials

- **Tools** — each tool has `input` / `output` JSON Schema and optional `verify` (`evidence`, `absence`, `effect`, live-only `judge`). The YAML `tools:` list is the only capability surface the model sees.
- **Gates** — pre-exec predicates on capability, sequences, limits.
- **Counterbalance bridge** (`counterbalance:`) — `sequences`, `invalidate_after`, `completion`, checkpoints, orientation. Normative contract: [`spec-v0.2.md`](spec-v0.2.md).
- **Permissions** — `tools`, `filesystem.read_scopes` / `write_scopes`. Deployment `world.scopes` may **narrow** but never widen agent scopes.
- **Roles** — different instincts = different harness dirs (subagents). Host code sequences `run()` calls; do not multiplex roles with in-YAML modes.

### Structured deny signals (`failure`)

Counterbalance denies (`completion_gate_failed`, `sequence_requirement_failed`, `checkpoint_authority_failed`) carry a machine-checkable `failure` object on the event — not free-text `hint`s.

| `failure.kind` | Meaning |
|----------------|---------|
| `predicate` | Failing state paths under `completion.require` or sequence `require_state` |
| `missing_prior_tools` | Sequence prior tools not yet executed |
| `checkpoint_key` | Checkpoint tool attempted a key outside `allow_set_keys` |

When a checkpoint's `allow_set_keys` covers a failing `eq` path, the engine MAY attach `unblock: { tool, set_key, set_value }` so the model can clear the gate. Live hosts MAY render prose from `failure` for tool results; Track A fixtures store structure only.

Reference: [`examples/coding-counterbalance/agents/`](../examples/coding-counterbalance/agents/) (live) and root [`agent.yml`](../examples/coding-counterbalance/agent.yml) (recorded/smoke).

## Deployment bindings

Map each agent tool to a native:

| Family | When to use |
|--------|-------------|
| `sim.*` / `stub.*` | Track A, smoke, default `fausth test` |
| `local.*` | Real FS/process inside a **linked disposable git worktree** |

Do not mix `local.*` with `sim.*`/`stub.*` in one deployment.

Local natives: `local.fs_read`, `local.fs_write`, `local.shell`, `local.user_approve`, `local.user_approve_auto` (test-only), `local.user_correct`, `local.user_correct_auto`, `local.task_complete`, `local.phase_yield`.

## Track A fixtures

Golden dirs under `conformance/fixtures/` must stay byte-stable. New semantics need a **failing fixture first**, then the runtime change. Never rewrite existing goldens to greenwash live logs.

## Local worktree safety

Real writes require `--workspace` pointing at a **linked** git worktree (not the primary checkout). Fausth rejects:

- Absolute / tool-supplied drive paths, `..`, NUL, `.git`
- Symlink/junction components that escape the worktree
- Shell commands outside the deployment allowlist (`world.commands`)
- Mixing local I/O with arbitrary host directories

Bootstrap:

```bash +code
node scripts/disposable-worktree.mjs bootstrap --parent . --tiny-seed true
# … run fausth …
node scripts/disposable-worktree.mjs cleanup --parent . --worktree <path>
```

Recorded disposable e2e (CI-safe):

```bash +code
pnpm ci:local-e2e
```

## Workflow

```bash +code
pnpm fausth -- validate examples/coding-counterbalance
pnpm fausth -- test examples/coding-counterbalance
pnpm fausth -- inspect examples/coding-counterbalance
pnpm fausth -- pack examples/coding-counterbalance --out dist/coding.fausth.json
pnpm fausth -- unpack dist/coding.fausth.json --out /tmp/harness --force
pnpm fausth -- pack examples/primitives/inline-file-connectors --out dist/connectors.fausth.json
pnpm fausth -- pack examples/primitives/inline-file-connectors --out dist/connectors.signed.fausth.json --sign-key seed.hex
pnpm fausth -- verify dist/connectors.signed.fausth.json
pnpm fausth -- run dist/connectors.fausth.json --dump /tmp/events.jsonl
pnpm fausth -- run examples/coding-counterbalance \
  --deployment examples/coding-counterbalance/deployment.local-fixture.yml \
  --workspace <linked-worktree> \
  --model conformance/fixtures/cb-coding-happy-path/model.jsonl \
  --expect-complete true \
  --report live/reports/run.json
```

`validate` / `test` / `inspect` / `resolve` / `run` accept either a harness directory or a `.fausth.json` bundle (unpacked to a temp dir). For v0.2 bundles, the verified embedded resolved IR is authoritative.

## Security limitations (honest alpha)

- Not a sandbox VM. Isolation is **worktree containment + argv allowlist**, not production multi-tenant isolation.
- Interactive checkpoints need a TTY; automation must use `*_auto` natives explicitly.
- Live models are secrets-gated and flaky; Track A never depends on them.
- Browser, Python live transport, registry, and production-grade isolation remain out of scope for this alpha.
