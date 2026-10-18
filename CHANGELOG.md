# Changelog

## 0.5.1 — 2026-10-18

Additions for harness-lab's first harness series (minimal, strategist, squad). Every 0.5.0 harness
stays valid and sees the same tokens.

### Spec
- `core_called_since` takes a list of tools as `tool`: the check passes if any of them has a seen
  successful call after `since`, and the failure text joins the ids with ` or `
  (`board_check or board_piece not called yet`). Needed by the chess strategist harness ("check a move or
  inspect a piece before moving"). A built-in rather than a host handler, so every engine computes it and
  words it the same, and replay recomputes it (§5.1, §6, schema). Files still declare `spec: harness/0.5`;
  a 0.5.0 engine rejects a harness that uses the list.

### Conformance
- Fixture `builtin-called-since-list` (passes through the second tool, fails before any call, resets on
  `since`, a same-response call doesn't count, a one-id list on `stop`); harness cases for the list
  (valid, empty, duplicate, undeclared, non-id, and a list on `core_count`).

### Chess tools
- New tools on both hosts, with the same results: `board_check`, `board_piece`, `board_history`,
  `board_resign`. `board_move` takes `position_hash` as optional.
- For hosts: `move_problem` (the nine move-rule sentences), `render_board` (five formats, two
  orientations) and `turn_brief` (the brief before each move), which harness-lab's `chess_move_rules`
  and `turn_brief` handlers are built on.
- `conformance/chess-tools.json`: 108 python-chess vectors that the chess.js tools reproduce.

## 0.5.0 — 2026-10-17

A rebuild on one small, normative spec: `docs/spec-v0.5.md` (drafted as v0.4), built along
`docs/build-plan-v0.4.md`. Harness files declare `spec: harness/0.5`.

### Spec
- A harness wires tools, hook-only handlers and hooks; the log is the only state; every model request
  is a function of the harness and the log (§0, §9). Seven events, seven decisions, five built-ins
  (`core_called_since`, `core_last_result`, `core_count`, `core_deny`, `core_context`) that pass only on
  results the model had seen (§4–§6). `core_spawn` runs a child harness the model writes, never with
  more than its parent (§10). Interrupts and live reload at step boundaries (§11, §12.3).
- Values in RFC 8785 canonical form, numbers as doubles (§1). Hook decisions reach the model in one
  fixed wrapper (§9.2, §9.3). The provider-neutral request is fixed, so `expected.requests.jsonl`
  tests exactly what a model sees (§9, §14).

### Engines and hosts
- TypeScript (`engines/ts`, about 900 lines) and Python (`engines/py`, about 1,150; its YAML 1.2 reader and
  regex translation make the difference) engines, each with an OpenAI-compatible adapter. Conformance: 46 recorded fixtures, 114 harness examples, value, log and
  adapter vectors; both engines reproduce them byte for byte, and so does the TS engine in a browser.
- Hosts: `python -m fausth run <harness> --deployment <file>` (script, recorded and model bindings,
  python-chess tools) and `hosts/web`, one HTML page with chess.js tools. The spec's §2 chess harness
  played live on both (KIT gateway, OpenRouter).

### Review fixes (before the release)
- Limits are checked with `≥`; with `=`, a live reload that lowered a limit below what was used let the
  run go on unbounded. A reload's `max_steps` applies at once.
- `host_end` is reachable: a host ends the run by raising `HostEnd`; both hosts do so when the harness's
  `timeout_ms` has passed, and a recording asks for it with `{end: true}`. A child's `host_end` ends the
  whole run.
- Malformed user messages and `reasoning_opaque` are infrastructure failures instead of crashes; a harness
  without a canonical form is invalid for every caller; the command line reports unreadable files.
- Seven fixtures for these cases, including a `pre_tool` hook that modifies a `core_spawn` call.

### Retired
- Spec v0.1–v0.3 and the v0.3 documents moved to `docs/archive/`. The v0.3 engines, fixtures, schemas,
  scripts, examples, worlds and case studies are removed; they stay reachable through the
  `v0.4.0-alpha` tag. No compatibility layer.

## 0.4.0-alpha — 2026-10-14 (audit release)

Every finding of the 2026-10-12 audit fixed. Details: `AUDIT-STATUS.md`, `case-studies/CLAIMS-STATUS.md`,
release note `docs/archive/releases/RELEASE-v0.4.0-alpha.md`.

### Contract (spec)
- `docs/spec-v0.3.md` is normative (D1–D16). The validator accepts spec ids v0.1–v0.3 for the one executable IR and
  closes the schema at every level, so a typo can no longer silently drop a rule. Every emitted reason code is specified.
- D8: only executed-and-verified calls count as success. A verify failure discards the call's state transition.
- D6: spawn is denied unless `spawn.allow: true`. Children are charged to the parent.
- D9: checkpoint authority is checked at authorize, and only declared keys are writable.
- D10: recovery goes through the governed path.
- D11: no harness names in the engines. Tools declare `effects` instead.
- D14: the user cell is a host user channel (`channel: user`; recorded / simulator / human); never self-answered.
- Goldens re-derived from the spec, and 29 new `v03-*` fixtures (87 total).

### Engines
- TS: build and `tsc` clean. `bin` runs the current sources. Schemas are cached. Overlays may only narrow.
  Metrics are honest, and boolean CLI flags work.
- Python: a line-by-line port of the v0.3 runtime (`engines/py/fausth/engine.py`). YAML 1.2, standard JSON
  Schema, code-point canonical JSON. Replay is 87/87 byte-identical to TS, and `parity.mjs` + IR fuzz are green.

### Trust boundary
- Signer trust store (`--trusted-keys`, `--require-trusted`) with exit codes 0/1/2/3. Bundle sources are re-resolved
  against the embedded IR.
- Env allowlists for MCP/module children, with cleanup. Bundle-shipped commands need explicit allowance.
- Scopes, protected paths and symlinks are checked on normalized and real paths. All checks run before writes.
- Typed transport errors (infra vs `request_rejected`). Per-call completion ids are recorded (cache-duplicate detection).
- Bundles carry `user.answers.jsonl` (recorded user answers).

### Case studies and scripts
- τ-bench retail world ported faithfully. Safe `calculate` (no `Function()`). The hidden instruction goes only to a
  user simulator. Seeds are deduplicated (−8.5M lines).
- SWE grader follows upstream SWE-bench grading in per-task environments, validated on 25/25 tasks.
  The old Track S "0%" is retracted as an invalid measurement.
- Runner:
  - workspaces contain only the seed;
  - no gold data in prompts or host decisions;
  - pass@1 everywhere, with paired statistics (clustered bootstrap, McNemar);
  - full provenance, and no stale-artifact re-scoring.
- CI runs script tests, recorded matrices, release and evidence checks as independent jobs.

### Models
- KIT defaults: `kit.glm-5.3-flash`, plus `kit.deepseek-v4-flash`. Retired ids fail fast.
  Note: the gateway caches glm responses by request body.

## Unreleased

### Docs hygiene

- Human map: [`docs/README.md`](docs/README.md); examples index; evidence-pack validator (`pnpm evidence:check`).
- Point-in-time `RELEASE-v0.*.md` and superseded `spec-v0.2-draft.md` moved to [`docs/archive/`](docs/archive/).
- CasaOS deploy + in-repo Lab UI removed (live in `/home/mark/fausth-lab`). `live/cache/` and `live/archive/` gitignored.
- Chess extracted to sibling project `/home/mark/chess-harness` (Fausth consumer). Not part of this runtime.

### Mutable cells, module connectors, overlays (M16–M18)

### Added

- Mutable-cell self-editing: `mutable: [skills|memory|instincts]`, `harness.propose_skills_patch`, `harness.decline_skills_patch`, unified `harness.reflect_skills`, `require_prior_any_of`, `rebalance` stage, `fausth select`.
- Track A fixtures: `cb-harness-patch-skills-ok`, `cb-harness-patch-security-denied`, `cb-harness-patch-memory-cautious`, `cb-decline-skills-ok`, `cb-reflect-before-yield-denied`.
- Example: [`examples/mutable-skills/`](examples/mutable-skills/); coding fork [`examples/coding-mutable-skills/`](examples/coding-mutable-skills/) (research/plan baseline-like; implementation reflect-after-tests; host auto-decline).
- Case study: [`case-studies/mutable-cells/`](case-studies/mutable-cells/) (host: `--manifest`); mid-v3 parity Δ = 0 on task_success.
- `kind: module` connectors: offline resolve via `fausth-module-manifest/v0.1` (subprocess execution model; no in-process JS/WASM). Example: [`examples/primitives/module-connectors/`](examples/primitives/module-connectors/).
- Model-adaptive overlays (`overlays` / `resolveOverlay`) — narrow-only tools/limits.
- Docs: [`docs/production-isolation.md`](docs/production-isolation.md) (deferred scope); PROTOCOL P2 expansion section.

### Notes

- Skills patches may only change tool `description` (v0.1 IR). Security/checkpoints remain immutable.
- README still excludes production isolation, universal live completion, and safety beyond case-study bounds.

## 0.3.0-alpha — Output verifies, memory TTL, audit, budgets (M12–M15)

### Added

- Output-surface verifies (`kind: output`) with `verify_output_failed` — predicates on `message.contains_code_fence` / content (Track A).
- Memory provenance map + `invalidate_after.ttl_steps` time-based staleness (mutation `action` rules unchanged).
- `fausth audit` / `fausth-py audit` — deny-log sensor (capability_missing, structured failures, near-misses, output/TTL/budget counters).
- `intervention_budget` + declarative `triggers`; engine emits `budget_exceeded` record events for `window: run`. Host demo: `scripts/intervention-host.mjs`.
- Spec draft / schema: [`docs/spec-v0.3-draft.md`](docs/spec-v0.3-draft.md), [`schema/counterbalance-contract.v0.3.json`](schema/counterbalance-contract.v0.3.json).
- Theory hub drafts: [`docs/notion-hub/`](docs/notion-hub/) (control timing, deny-as-sensor); design doc [`docs/self-improving-harnesses.md`](docs/self-improving-harnesses.md) (mutable cells — implemented in Unreleased/M16).
- Fixtures: `cb-chat-*`, `cb-stale-after-ttl`, `cb-memory-provenance-status`, `cb-budget-exceeded`.

### Notes

- Normative promotion of v0.3 sections rides on Track A fixtures; v0.1/v0.2 goldens remain immutable.
- Unsigned coding `v0.1` pack size pin remains **15411** bytes.
- Mutable-cell self-editing was design-only at the `0.3.0-alpha` cut; see Unreleased.
## 0.2.0-alpha — Normative structured denies (contract v0.2)

### Added

- Normative [`docs/spec-v0.2.md`](docs/spec-v0.2.md) and [`schema/counterbalance-contract.v0.2.json`](schema/counterbalance-contract.v0.2.json).
- Structured deny signal `failure` on Counterbalance denies (`predicate` / `missing_prior_tools` / `checkpoint_key`), with optional checkpoint-derived `unblock`.
- `fs.list` read-only discovery tool; instructive shell allowlist errors.
- Case-study scoring: `discovery_failure`, `obsolete_surface_call`, floor/ceiling headline deltas.
- CLI contract-loop teaching on by default for live coding runs.

### Removed

- In-engine **modes** (`counterbalance.modes`, `mode.enter`, `mode_denied`, orientation `available_modes`).
  Capability limits come only from each harness YAML's tool list. Phased work uses separate
  subagent dirs; host code owns launch order.
- Fixture `cb-write-in-research-mode-denied` → `cb-write-not-provisioned` (`capability_missing`).
- Ad-hoc free-text `hint` on deny events (hosts may still render prose from `failure` for live models).

### Notes

- Normative contract is now **`counterbalance-contract/v0.2`**. v0.1 remains for pre-CB goldens.
- Unsigned coding `v0.1` pack size pin: **15411** bytes.
- Post-cut live baseline gate documented in [`docs/case-studies/PROTOCOL.md`](docs/case-studies/PROTOCOL.md) as `v0.4.0-baseline` (not run in this cut).

## 0.1.3-alpha — Portable connectors, signatures, MCP (M10–M11)

### Added

- Connector manifest + resolved harness IR (`fausth resolve`, `pnpm ci:resolve`).
- Portable resolved bundles: `fausth-harness-bundle/v0.2` (connectors) and `v0.3` (MCP descriptors).
- Optional Ed25519 detached bundle signatures (`fausth pack --sign-key`, `fausth verify`).
- MCP connectors (`kind: mcp`) with offline resolve and host transports `recorded` / `stdio`.
- Live proofs: `scripts/live-mcp-stdio.mjs` (process) and `scripts/live-mcp-model.mjs` (KIT/OpenRouter + MCP).
- Example harness: [`examples/primitives/mcp-connectors/`](examples/primitives/mcp-connectors/).
- Opt-in `limits.continue_after_deny` (default remains terminal deny for Track A goldens).
- Coding case-study live protocol v0.2: held-out grader, single-mode permissive control,
  outcome-based scorer, KIT 80-attempt matrix (`live-kit-v2`).

### Notes

- Legacy coding packs without connectors remain **byte-identical** `v0.1` (17022 bytes unsigned).
- `kind: module` is schema-recognized but fails closed until a later milestone.
- Normative contract remains **`counterbalance-contract/v0.1`**.
- Recorded case-study traces are plumbing regression only; live results are in
  [`examples/coding-counterbalance/VERIFICATION.md`](examples/coding-counterbalance/VERIFICATION.md).

## 0.1.2-alpha — Usable local coding harness (M8)

### Added

- Disposable-worktree-only local adapter (`local.fs_*`, `local.shell`, interactive and `*_auto` checkpoints).
- Path/scope enforcement (`sandbox-path`) rejecting primary checkout, traversal, `.git`, and escaping symlinks/junctions.
- Explicit `deployment.local-*.yml` for coding-counterbalance (never auto-selected by `test` / replay).
- Harness bundle schema `fausth-harness-bundle/v0.1`, safe unpack, and bundle-aware `validate` / `test` / `inspect` / `run`.
- `fausth unpack` (TS + Python) and TS↔Python byte-identical pack (`scripts/bundle-roundtrip.mjs`).
- `fausth run --workspace/--prompt/--task-file/--report/--expect-complete`.
- Track B report fields: `completion_reached`, `e2e_pass_rate` (separate from deny catch rate).
- Disposable worktree bootstrap/cleanup and recorded local e2e (`pnpm ci:local-e2e`).
- Authoring guide: [`docs/authoring.md`](docs/authoring.md).

### Notes

- Normative contract remains **`counterbalance-contract/v0.1`**. Bundle format is `v0.1`. Spec `v0.2` is still a non-normative draft.
- Real KIT/OpenRouter coding e2e in a disposable worktree is nightly/manual and secrets-gated.

## 0.1.1 — Baseline (M0–M7 + polish)

- Dual-runtime Track A conformance, Counterbalance bridge, support-bot world, binding registry, multi-host smoke, live Track B, nested spawn, packaging CLI.
- See [`docs/BASELINE-v0.1.md`](docs/BASELINE-v0.1.md) and tag `v0.1.1-baseline`.
