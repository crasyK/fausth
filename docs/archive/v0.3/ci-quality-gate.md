# Faust as a CI quality gate

Faust’s **reference product surface** for external event repos: a **portable, governed AI quality gate** inside GitHub Actions — not a third engine, and **not** the definition of Fausth.

Fausth itself is the Counterbalance harness runtime ([`counterbalance-architecture.md`](counterbalance-architecture.md)). SLOPATHON-style CI is one host adapter configuration among coding, support, and future surfaces.


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

AI findings must match a closed schema and survive deterministic evidence checks. Unsupported conclusions are dropped before they reach the maintainer. The gate (`verifyFindingEvidence`, also enforced inside `finding.submit`) is strict — arguments are type-checked, never cast:

- `category` ∈ the closed category set; `severity` ∈ `info | warning | blocking`.
- **Advisory severity:** the model layer may only use `info` or `warning`. `blocking` is reserved for Layer 1 (deterministic checks); a model finding marked `blocking` is rejected, not silently downgraded. Use `human_review` when a maintainer must decide.
- `evidence` is a non-empty string that occurs verbatim in an included packet file of the submission.
- `line_start`, when given, is an integer within the cited file (NaN / floats / 0 are rejected).
- `recommendation` is a non-empty string.

Rejections carry one reason from a closed set (`FINDING_REJECT_REASONS`): `invalid_category`, `invalid_severity`, `severity_reserved_for_deterministic`, `invalid_path`, `path_not_in_packet`, `path_outside_submission`, `evidence_empty`, `evidence_not_found`, `line_invalid`, `line_out_of_range`, `recommendation_empty`.

## Secret redaction

One closed list of secret shapes drives both detection and redaction (`redactSecrets` / `containsSecret` in `integrations/github/submission-check.ts`): `key = value` / `key: value` assignments for api_key/secret/token/password, `sk-…` keys (incl. `sk-or-v1-…`), GitHub tokens (`ghp_ gho_ ghu_ ghs_ ghr_ github_pat_`), AWS access key ids (`AKIA…`/`ASIA…`), Slack tokens (`xox[abprs]-…`), Bearer tokens, and PEM `PRIVATE KEY` blocks.

- A file containing any of them is a blocking `potential_secret` finding; its packet content is replaced and the finding evidence names the shape (`[REDACTED:github_token]`, `password: [REDACTED]`), never the value.
- Redaction is applied to **every** outbound channel: deterministic and advisory finding evidence/recommendations (redact first, then truncate — a cut can never expose a partial secret), the rendered markdown, the step summary, PR comments, Check Run title/summary, workflow-command annotations, and the PR title/snippets sent to the model.
- Workflow-command annotations escape untrusted values per the GitHub spec (`%`, CR, LF in messages; additionally `:` and `,` in `file=` / `title=` properties), so a crafted PR filename cannot inject commands.

## Reporting

Each layer is **one** Checks job (`Submission L1` / `Submission L2`). The readable report goes to the job **summary**. Duplicate Check Runs, file-annotation spam, and PR comments are off by default (`--post 1`); opt in with `--annotate`, `--check-run`, or `--comment` if needed.

See [`examples/slopathon-review/`](../examples/slopathon-review/) for the HACK//OPS / SLOPATHON host example.
