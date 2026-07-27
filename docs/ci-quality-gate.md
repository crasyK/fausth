# Faust as a CI quality gate

Faust’s first product surface for external repos: a **portable, governed AI quality gate** inside GitHub Actions — not a third engine.

## Engines vs hosts

| Layer | Role |
|-------|------|
| Engine | Counterbalance semantics (`engines/ts`, `engines/py`) |
| Host | CLI or GitHub Actions invokes an engine |
| Transport | OpenAI-compatible + profiles (`openrouter`, `kit-scc`, …) |

GitHub Actions **hosts** the TypeScript engine and binds tools to the GitHub API. It is not `engines/gha`.

## Layered review

```text
PR opened
  → Layer 1: deterministic structural / security checks (blocking)
  → review-packet.json
  → Layer 2: Faust-bounded LLM review (advisory, label-gated)
  → evidence verification strips unsupported findings
  → human merge decision
```

### Conclusion codes

| Code | Meaning |
|------|---------|
| `pass` | Hard checks satisfied |
| `fail` | Blocking structural/security violation |
| `action_required` | Needs human attention (often from advisory) |
| `neutral` | Model/job skipped (e.g. rate limit) — **not** a pass |
| `infrastructure_error` | Missing key / runtime failure — **not** a pass |

Model unavailability must never be recorded as submission success.

## Fork-safe secrets

| Workflow | Trigger | Secrets |
|----------|---------|---------|
| Deterministic | `pull_request` | none |
| Advisory | label `faust-review` | `OPENROUTER_API_KEY` or `KIT_AI_API_KEY` |

Never use `pull_request_target` with checkout/execution of contributor code while secrets are present. Faust binary comes from the trusted base / pinned commit; PR content arrives as inert API data.

## Providers

- **OpenRouter** — public advisory demo (free models).
- **KIT KI-Toolbox** (`kit.*` local models) — institutional portability; `api_key_env: KIT_AI_API_KEY`; continuous bots need a proper service account per KIT policy.

## Evidence-bound findings

AI findings must match a closed schema and survive deterministic evidence checks (cited path exists, line in range, snippet occurs). Unsupported conclusions are dropped before they reach the maintainer.

## Reporting

Findings land on the **Checks** tab (check-run title states the problem; annotations point at paths). PR comment spam is off by default (`--post 1`); use `--comment 1` only if you explicitly want a comment.

See [`examples/slopathon-review/`](../examples/slopathon-review/) for the reference integration.
