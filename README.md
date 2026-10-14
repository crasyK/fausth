# Faust Harness (`fausth`)

Portable runtime for **agent harnesses**: declare tools, gates, and verify rules once; run the same contract in simulation, locally, in CI, or against live models.

The model proposes. Fausth governs what may run and how the world must prove it worked.

**Status:** [v0.4.0-alpha](https://github.com/crasyK/fausth/releases/tag/v0.4.0-alpha) · executable contract normative in [`docs/spec-v0.3.md`](docs/spec-v0.3.md) (one IR, spec ids `counterbalance-contract/v0.1`–`v0.3`; the v0.2 agent/world/exchange authoring shape is a non-loadable draft) · **not** production-safe

**Human map:** [`docs/README.md`](docs/README.md) · **Issues:** [github.com/crasyK/fausth/issues](https://github.com/crasyK/fausth/issues)

Chess research lives in a **separate project** (`/home/mark/research/chess-harness`) that installs the Python runtime (`fausth` from `engines/py`). It is not part of Fausth.

## Why it exists

| Claim | Meaning |
|-------|---------|
| **Track A (deterministic)** | Same harness → **byte-identical** event logs on TypeScript and Python |
| **Track B (live)** | Same gates against real models — never pollutes goldens |

## Quick start

```bash
corepack enable && pnpm install   # Node 22+
pnpm test
pnpm fausth -- help
```

Try a harness:

```bash
pnpm fausth -- test examples/coding-counterbalance
pnpm fausth -- pack examples/coding-counterbalance --out live/reports/out.fausth.json
```

## How-to

| Task | Guide |
|------|-------|
| Start here (humans + agents) | [`docs/README.md`](docs/README.md) |
| Author a harness | [`docs/authoring.md`](docs/authoring.md) |
| Pack, sign, verify, resolve, MCP | [`docs/HOW-TO.md`](docs/HOW-TO.md) |
| OpenAI-compatible models (KIT / OpenRouter) | [`docs/openai-compatible.md`](docs/openai-compatible.md) |
| CI quality gate (SLOPATHON-style) | [`docs/ci-quality-gate.md`](docs/ci-quality-gate.md) · [`examples/slopathon-review/`](examples/slopathon-review/) |
| Case studies | [`docs/case-studies/`](docs/case-studies/) |
| Evidence pack | [`docs/evidence-pack.md`](docs/evidence-pack.md) |
| Packaging roadmap (M4–M15) | [`docs/harness-packaging-roadmap.md`](docs/harness-packaging-roadmap.md) |
| Spec & theory | [`docs/spec-v0.3.md`](docs/spec-v0.3.md) (normative) · [`docs/spec-v0.3-draft.md`](docs/spec-v0.3-draft.md) (open candidates) · [`docs/notion-hub/`](docs/notion-hub/) |
| Known issues | [`docs/KNOWN-ISSUES.md`](docs/KNOWN-ISSUES.md) |

## What 0.4.0 proves (short)

The audit release (2026-10-14): every finding of the 2026-10-12 audit fixed, both engines rebuilt on one
normative spec.

- **One normative contract.** [`docs/spec-v0.3.md`](docs/spec-v0.3.md) (decisions D1–D16): honest verdicts (a
  verify-failed call never counts as success), tighten-only spawn, governed recovery, closed schemas, no
  harness names in the engine, declared tool `effects`, a real **user channel** (recorded / simulator / human).
- **Same tokens everywhere, proven.** TS and Python replay all 87 conformance fixtures byte-identically;
  `scripts/parity.mjs` and the IR fuzzer agree across canonical JSON, YAML 1.2, schemas, worlds and 200 random runs.
- **Trust boundary.** Signer trust store, env allowlists for child processes, protected-path and symlink-safe
  scopes, no `Function()` on model input.
- **Measurement you can rely on.** Case-study graders fixed and self-tested (SWE grader validated on 25/25 tasks),
  gold leakage removed, paired statistics, invalid claims retracted — see
  [`case-studies/CLAIMS-STATUS.md`](case-studies/CLAIMS-STATUS.md).

## What 0.3.0 proves (short)

- M12 `kind: output` verifies (chat surface) + Track A fixtures
- M13 memory provenance + `ttl_steps` invalidation
- M14 `fausth audit` deny-log sensor (TS + Python)
- M15 intervention budgets / triggers + host demo runner
- Theory drafts: control timing, deny-as-sensor, evidence independence ([`docs/notion-hub/`](docs/notion-hub/))
- M16 mutable-cell self-editing (`mutable`, `harness.propose_skills_patch`, `fausth select`) — Track A fixtures; example [`examples/mutable-skills/`](examples/mutable-skills/)

## What 0.1.3 proves (short)

- Dual-runtime Track A + multi-host smoke
- Packaging: `validate` / `test` / `inspect` / `pack` / `unpack` / `run` / `verify` / `resolve`
- Bundles `v0.1` · `v0.2` (connectors) · `v0.3` (MCP); optional Ed25519 signatures
- MCP connectors: recorded CI + live stdio; live model + MCP (KIT / OpenRouter)
- Local coding in disposable worktrees; CI review example for event repos
- Coding Counterbalance case-study protocol + **live** 80-attempt KIT pilot
  ([`examples/coding-counterbalance/CASE-STUDY.md`](examples/coding-counterbalance/CASE-STUDY.md))

Still **not** claimed: production isolation, universal live-model task completion,
or agent safety outside the published case-study bounds.
See [`docs/production-isolation.md`](docs/production-isolation.md) and PROTOCOL P2 expansion.

## Security (alpha)

- Real FS/process I/O only with explicit `deployment.local-*.yml` and `--workspace` = linked disposable worktree
- MCP `stdio` spawns a real process — not a sandbox
- Bundle signatures are integrity checks, not a trust boundary for untrusted authors

## Spec & theory

[`docs/spec-v0.3.md`](docs/spec-v0.3.md) (normative; overrides v0.1/v0.2 on conflict) · [`docs/spec-v0.2.md`](docs/spec-v0.2.md) · [`docs/spec-v0.1.md`](docs/spec-v0.1.md) · [`docs/spec-v0.3-draft.md`](docs/spec-v0.3-draft.md) · [`docs/architecture.md`](docs/architecture.md) · [`docs/counterbalance-architecture.md`](docs/counterbalance-architecture.md) · [`docs/glossary.md`](docs/glossary.md)

Point-in-time release notes: [`docs/archive/releases/`](docs/archive/releases/). Changelog: [`CHANGELOG.md`](CHANGELOG.md).

## License

Apache-2.0 — `LICENSE` · `NOTICE`

https://github.com/crasyK/fausth
