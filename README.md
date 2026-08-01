# Faust Harness (`fausth`)

Portable runtime for **agent harnesses**: declare tools, gates, and verify rules once; run the same contract in simulation, locally, in CI, or against live models.

The model proposes. Fausth governs what may run and how the world must prove it worked.

**Status:** [v0.3.0-alpha](https://github.com/crasyK/fausth/releases/tag/v0.3.0-alpha) · contract `counterbalance-contract/v0.2` (+ v0.3 candidates) · **not** production-safe

## Why it exists

| Claim | Meaning |
|-------|---------|
| **Track A (deterministic)** | Same harness → **byte-identical** event logs on TypeScript and Python |
| **Track B (live)** | Same gates against real models — never pollutes goldens |

## Quick start

```bash +code
corepack enable && pnpm install
pnpm test
pnpm fausth -- help
```

Try a harness:

```bash +code
pnpm fausth -- test examples/coding-counterbalance
pnpm fausth -- pack examples/coding-counterbalance --out live/reports/out.fausth.json
```

## How-to

| Task | Guide |
|------|-------|
| Author a harness | [`docs/authoring.md`](docs/authoring.md) |
| Pack, sign, verify, resolve, MCP | [`docs/HOW-TO.md`](docs/HOW-TO.md) |
| OpenAI-compatible models (KIT / OpenRouter) | [`docs/openai-compatible.md`](docs/openai-compatible.md) |
| CI quality gate (SLOPATHON-style) | [`docs/ci-quality-gate.md`](docs/ci-quality-gate.md) · [`examples/slopathon-review/`](examples/slopathon-review/) |
| Case studies (coding pilot) | [`docs/case-studies/`](docs/case-studies/) · [`examples/coding-counterbalance/CASE-STUDY.md`](examples/coding-counterbalance/CASE-STUDY.md) |
| Packaging roadmap (M4–M15) | [`docs/harness-packaging-roadmap.md`](docs/harness-packaging-roadmap.md) |
| Spec & theory (v0.3 draft) | [`docs/spec-v0.3-draft.md`](docs/spec-v0.3-draft.md) · [`docs/notion-hub/`](docs/notion-hub/) |

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
  (held-out grader; recorded traces are plumbing only):
  [`examples/coding-counterbalance/CASE-STUDY.md`](examples/coding-counterbalance/CASE-STUDY.md)
  · [`docs/case-studies/`](docs/case-studies/)

Still **not** claimed: production isolation, universal live-model task completion,
or agent safety outside the published case-study bounds.
See [`docs/production-isolation.md`](docs/production-isolation.md) and PROTOCOL P2 expansion.

## Security (alpha)

- Real FS/process I/O only with explicit `deployment.local-*.yml` and `--workspace` = linked disposable worktree
- MCP `stdio` spawns a real process — not a sandbox
- Bundle signatures are integrity checks, not a trust boundary for untrusted authors

## Spec & theory

[`docs/spec-v0.2.md`](docs/spec-v0.2.md) · [`docs/spec-v0.3-draft.md`](docs/spec-v0.3-draft.md) · [`docs/spec-v0.1.md`](docs/spec-v0.1.md) · [`docs/architecture.md`](docs/architecture.md) · [`docs/counterbalance-architecture.md`](docs/counterbalance-architecture.md) · [`docs/glossary.md`](docs/glossary.md)

## License

Apache-2.0 — `LICENSE` · `NOTICE`

https://github.com/crasyK/fausth
