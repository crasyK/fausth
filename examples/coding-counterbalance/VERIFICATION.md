# Verification: Coding Counterbalance (v0.3)

Status: **subagent redesign + adapter reliability** shipped. Live pin remains
Gemma + Minimax; Mistral and Qwen also pass the engagement gate on v0.3.

Protocol: [`docs/case-studies/PROTOCOL.md`](../../docs/case-studies/PROTOCOL.md).  
Narrative: [`CASE-STUDY.md`](CASE-STUDY.md).

## Design (v0.3)

Counterbalance is **capability provisioning**, not classical security:

- Each role is its own `agent.yml` under `agents/{research,plan,implementation}/`
- The YAML `tools:` list is the only tool schema the model receives
- Orientation lists only present tools (no `blocked_tools`)
- Host code decides when each phase launches; the case-study runner uses a fixed pipeline
- Permissive control is one open YAML with all coding tools (true ablation)

## Adapter reliability

| Guard | Behavior |
|-------|----------|
| `tool_choice: required` | Agent loops force a tool call when tools are offered |
| Required→auto fallback | If gateway rejects `required`, or returns `tool_calls` finish with an empty message, retry once with `auto` (KIT Minimax quirk) |
| Empty-stop retry | One nudge + retry; second empty → `empty_proposal` |
| Empty thrash cap | Runtime stops after 2 consecutive `empty_proposal` denies |
| Invalid preserved | Bad tool JSON is not collapsed to a silent successful stop |
| `engaged` score | Attempts with zero tool proposes flagged separately |

Unit tests: `openai-compatible.test.ts`, `conversational-propose.test.ts`, `coding-subagents.test.ts`, `scripts/case-study-pipeline.test.mjs`.

## Pins (live smoke)

| Item | Value |
|------|-------|
| Models | `kit.gemma4-31b-it`, `kit.minimax-m2.7-229b` |
| Temperature | `0.7` |
| Max steps | `30` (implementation); research/plan capped at 12 |
| Conditions | pipeline counterbalanced vs permissive-control |
| Smoke gate | 0 orient+empty-propose attempts; Minimax ≥75% engaged |

```bash
pnpm ci:conformance
node --test scripts/case-study-pipeline.test.mjs
node scripts/case-study-coding.mjs --mode live \
  --kit-models kit.gemma4-31b-it,kit.minimax-m2.7-229b \
  --limit 8 --run-id live-kit-smoke-v4 --skip-conformance
```

### Smoke results

| Run | Result |
|-----|--------|
| `live-kit-smoke-v3` | Gemma: 8/8 engaged, 0 empty no-ops |
| `live-kit-smoke-v4-minimax` | Minimax: **4/4 engaged** (100%), 4/4 task success after required→auto empty-`tool_calls` fix |
| `live-kit-smoke-v4` | Limit 8: **8/8 engaged**, 0 empty_proposal (matrix filled Gemma first); gate passed with minimax run above |
| `live-kit-smoke-v4-mistral` | Mistral: **4/4 engaged**, 0 empty_proposal, 2/4 task success — no adapter change |
| `live-kit-smoke-v4-qwen` | Qwen: **4/4 engaged**, 0 empty_proposal, 4/4 task success — no adapter change (v0.3 + required/auto fixes cleared historical no-ops) |

Gate: zero orient+empty-propose no-ops; model ≥75% engaged — **passed** for Gemma, Minimax, Mistral, and Qwen.

### Reduced 4-model matrix (next)

```bash
node scripts/case-study-coding.mjs --mode live --kit-models all \
  --tasks 01-fix-add,02-add-multiply,05-rename-greet,06-fix-null-guard \
  --reps 3 --run-id live-kit-v3-reduced --skip-conformance
```

96 attempts (4 tasks × 4 models × 2 conditions × 3 reps). Primary metric: `task_success_engaged`.

## Historical archive

- `live-kit-v2` — single-model mode-based pin (mistral-small); see prior summary JSON
- `live-kit-all-v2` — 320 attempts across 4 models; **32.5% no-ops** contaminated pooled Δ; Gemma was the only model with zero no-ops
- `live-kit-smoke-v3-minimax` — pre-fix: 0/4 engaged under broken `tool_choice: required`

Do not treat mode-based advertise-then-deny results as the v0.3 design.
