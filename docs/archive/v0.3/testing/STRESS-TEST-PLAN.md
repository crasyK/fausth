# Fausth stress-test plan (benchmark-informed)

Status: **executable** (main). Goal: prove the **core engine** is right under every axis external agent benchmarks care about, *in Fausth terms* — then patch holes, **then** build the example library + browser demo.

Fausth’s claim: **given the same model and world, does the vessel reduce unsafe/wrong completions without killing task success?** Suites are framed as **CB vs PC** (or Track A determinism) unless stated otherwise.

**Harness Reliability Index (HRI v1):** import external tasks mostly **1:1** into Fausth worlds with **per-environment harness packs** — see [`HRI.md`](HRI.md). Track S ports a curated SWE-bench Lite slice (not a leaderboard claim). OSWorld/WebArena/GAIA remain deferred.

Final synthesis: [`STRESS-TEST-REPORT.md`](STRESS-TEST-REPORT.md).

---

## 0. External anchors (what we are *borrowing* from)

| Family | Repos / data | What we take |
|--------|----------------|--------------|
| SWE-bench / Verified | [swe-bench/SWE-bench](https://github.com/swe-bench/SWE-bench), [swebench.com](https://www.swebench.com/) | **HRI Track S:** Lite tasks 1:1 under Fausth CB/PC (not external harness) |
| GAIA | [gaia-benchmark/GAIA](https://huggingface.co/datasets/gaia-benchmark/GAIA) | Multi-tool assistant breadth (deferred: different product) |
| AgentBench / AgentBench FC | [THUDM/AgentBench](https://github.com/THUDM/AgentBench) | Cross-environment breadth checklist |
| OSWorld | [xlang-ai/OSWorld](https://github.com/xlang-ai/OSWorld) | Desktop multi-app ideas (deferred surface) |
| WebArena / BrowserGym / WorkArena | [web-arena-x/webarena](https://github.com/web-arena-x/webarena), [ServiceNow/BrowserGym](https://github.com/ServiceNow/BrowserGym) | Web/UI policy + ambiguity patterns (deferred surface) |
| τ-bench | [sierra-research/tau-bench](https://github.com/sierra-research/tau-bench) | Policy adherence + user simulation patterns |
| TheAgentCompany | [TheAgentCompany/TheAgentCompany](https://github.com/TheAgentCompany/TheAgentCompany) | Long-horizon multi-surface composition |
| WildClawBench (Safety T06.*) | [InternLM/WildClawBench](https://github.com/InternLM/WildClawBench), [HF dataset](https://huggingface.co/datasets/internlm/WildClawBench) | Adversarial safety task *taxonomy* inside normal workflows |
| AgentDojo | [ethz-spylab/agentdojo](https://github.com/ethz-spylab/agentdojo) | **Security + utility** joint scoring; adaptive attack mindset |
| InjecAgent | [uiuc-kang-lab/InjecAgent](https://github.com/uiuc-kang-lab/InjecAgent) | Indirect prompt injection → harm / data-steal cases |
| ToolEmu | [ryoungj/ToolEmu](https://github.com/ryoungj/ToolEmu) | High-stakes tool risk framing (safety vs helpfulness) |
| AgentHarm | [inspect_evals](https://github.com/UKGovernmentBEIS/inspect_evals) (community envs) | Refusal-under-tools while benign tasks still pass |
| EvoMemBench / Evo-Memory / AgentMemoryBench | [DSAIL-Memory/EvoMemBench](https://github.com/DSAIL-Memory/EvoMemBench), [zhaosnw/evo_mem](https://github.com/zhaosnw/evo_mem), [s010m00n/AgentMemoryBench](https://github.com/s010m00n/AgentMemoryBench) | Memory evolution *questions* (only if `memory` cell grows) |
| BFCL | Berkeley Gorilla leaderboard | Out of scope (function-call plumbing below our IR) |

---

## 1. Current test spine (what exists today)

| Layer | Where | Purpose |
|-------|--------|---------|
| Unit (TS) | `engines/ts/src/**/*.test.ts` | runtime, adapters, resolve, packaging, deny-failure, overlays, audit, connectors, github integrations |
| Track A conformance | `conformance/fixtures/` (53 fixtures after P0 harden) | deterministic engine semantics; TS + PY replay must be byte-identical |
| IR fuzz | `conformance/fuzz/` + `scripts/fuzz-ir.mjs` | seeded validate agreement TS↔PY (`pnpm ci:fuzz`) |
| Script tests | `scripts/case-study-score.test.mjs`, `case-study-pipeline.test.mjs` | scoring/pipeline math |
| CI bundles | `ci:conformance`, `ci:packaging`, `ci:resolve`, `ci:fuzz`, `ci:adversarial`, `ci:library-smoke`, … | engine + packaging + connectors + fuzz + adversarial recorded + library |
| Live case studies | `scripts/case-study-coding.mjs` + `case-studies/*` | CB vs PC / baseline vs mutable / adversarial on real models |
| KIT tmux shards | `scripts/kit-tmux-shard.mjs` | external parallelism for live KIT |

---

## 2. Principles

1. **Deterministic before live.** Every behavior the engine guarantees must exist first as Track A fixtures (byte-stable) and unit tests. Live KIT is evidence, not oracle.
2. **Paired evaluation.** Any “Fausth helps” claim runs **same model, same task, CB vs PC** (or baseline vs treatment) with existing scorer (`scripts/case-study-score.mjs`).
3. **Borrow taxonomies, not runtimes.** From WildClaw/AgentDojo/InjecAgent we steal *threat patterns*; from τ-bench *policy+user* patterns — reimplemented on Fausth worlds.
4. **Adversarial success = deny.** For security packs, correct outcome under CB is **blocked/steered**, under PC is unsafe success; score both (`attack_block_rate`).
5. **External KIT parallelism.** Never two writers on one `run_id`. No curriculum fan-out across tmux sessions.

---

## 3. KIT parallel runbook

### Measured capacity

| Probe | Date | Concurrent | Result |
|-------|------|------------|--------|
| `chat-probe` c1–c8 | 2026-08-01 | 1,2,4,8 one-shot chats | **8/8 OK, 0×429** (latency rises at c8) |
| Case-study L1 | 2026-08-01 | 1× gemma | completed, 0 infra |
| Case-study L3 | 2026-08-01 | 4 models | launched; early ledgers 0×429 |
| Case-study L4 | 2026-08-01 | 8 sessions (4 models × 2 bands) | launched to stress gateway |

**`KIT_PARALLEL_N = 8`** for short concurrent chat; for long case-study streams prefer **N≤4** until L4 ledgers confirm (Minimax dominates wall time). Failure modes to watch: `RATE_LIMIT`/`429` → `infrastructure_failure`; multi-hour stalls (not always rate-limit).

Artifacts: `live/reports/kit-probe/chat-probe-c*.json`, `*-shards.json`.

### Launcher

```bash
# Fast bound
node scripts/kit-tmux-shard.mjs chat-probe --level 8

# Case-study shards (detached tmux)
node scripts/kit-tmux-shard.mjs launch --level 1|2|4|8 \
  --run-id-prefix kit-probe --tasks 01-fix-add --reps 1
node scripts/kit-tmux-shard.mjs status --run-id-prefix kit-probe
node scripts/kit-tmux-shard.mjs aggregate --run-id-prefix kit-probe
```

Levels: **1**=1 gemma · **2**=gemma+minimax · **4**=all 4 models · **8**=4 models × 2 task bands.

### Anti-patterns

- Same `--run-id` from two sessions
- `--curriculum` / `--train-freeze-eval` across shards (one lineage = one session)
- Skipping Track A before a suite’s live pilot

### Env activate (each pane)

```bash
cd /home/mark/fausth
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use
export PATH="$NVM_DIR/versions/node/v22.23.1/bin:$PATH"
set -a && source .env && set +a
```

---

## 4. Suite matrix (build order)

### P0 — Engine invariants

| Suite | Coverage | Status |
|-------|----------|--------|
| `inv-sequences` | require_prior / continue_after_deny | fixtures `cb-deny-then-*`, `cb-write-before-plan-denied`, … |
| `inv-scopes` | read/write + write-lure + symlink | `cb-read-out-of-scope-informative`, **`cb-write-out-of-scope-informative`**, **`cb-symlink-read-denied`** |
| `inv-checkpoints` | user-only transitions | `cb-user-correction-cannot-be-self-authored` |
| `inv-completion` | stale / TTL / todos | `cb-stale-*`, `cb-completion-open-todos-denied` |
| `inv-patch` | harness patch allowlist | `cb-harness-patch-*`, `cb-reflect-before-yield-denied` |
| `inv-overlays` | narrow-only | `cb-overlay-*` |
| `inv-connectors` | unsigned / undeclared | `cb-module-connector-*` |
| shell allowlist | dangerous cmd | **`cb-shell-not-allowlisted-denied`** |

**Exit:** `pnpm test` + `ci:conformance` + `ci:packaging` + `ci:resolve`.

### P1 — IR fuzz + parity

| Suite | Mechanism | Status |
|-------|-----------|--------|
| `fuzz-ir-validate` | seeded near-miss IR; TS↔PY agree | `conformance/fuzz/` · `pnpm ci:fuzz` |

### P2 — Adversarial tool security

| Suite | Pattern | Status |
|-------|---------|--------|
| `adv-file-overwrite` | out-of-scope write lure | `case-studies/adversarial/` |
| `adv-dangerous-shell` | `rm -rf`-class | same |
| `adv-prompt-injection-doc` | injected goal in file | same |
| `adv-secret-exfil` | planted key → log | same |
| stubs | skill-injection, escalation-connector | README stubs |

Scorer: `attack_blocked` / `attack_block_rate` in `scripts/case-study-score.mjs`; live prefers `side-effects.json` via `adversarialSideEffects()`.  
CB live harness: pipeline [`case-studies/adversarial/harnesses/counterbalanced/agents/`](../../case-studies/adversarial/harnesses/counterbalanced/agents/) (plan → host gate → implementation; secrets on impl). Recorded uses monolithic root + `plan-before-write`.  
Recorded: `pnpm ci:adversarial`. Live:

```bash
node scripts/kit-tmux-shard.mjs launch --level 2 --run-id-prefix adv-live-v2 \
  --manifest case-studies/adversarial/manifest.yml \
  --tasks adv-file-overwrite,adv-dangerous-shell,adv-prompt-injection-doc,adv-secret-exfil --reps 2
```

Results: [`case-studies/adversarial/results/`](../../case-studies/adversarial/results/). Catch-rate smoke: `live/scenarios-adversarial/`.

### P3 — Policy + user simulation

| Suite | Mechanism | Status |
|-------|-----------|--------|
| `pol-support-scale` | support-bot sequences | existing + fixtures |
| `user-sim-ambiguity` | ask before act | fixtures `cb-ask-before-act-*`; example `examples/support-bot-ask/`; live `live/scenarios-support-ask/` |

### P4 — Scale & bandwidth

| Suite | Mechanism | Status |
|-------|-----------|--------|
| `world-bandwidth` | terse vs verbose orientation | `examples/coding-bandwidth-{terse,verbose}/` · [WORLD-BANDWIDTH.md](WORLD-BANDWIDTH.md) |
| `harness-library-smoke` | N harnesses `fausth test` | `pnpm ci:library-smoke` |

### P5–P6 / deferred

Unchanged: refusal-under-tools optional; memory evolution only if memory cell expands; OSWorld/WebArena/GAIA deferred.

---

## 5. Per-suite live budgets (at N=4)

| Suite | Sketch | Notes |
|-------|--------|-------|
| Coding CB probe | 1 task × 2 arms × 1 rep × 4 models = 8 | ~minutes–hours (Minimax) |
| Adversarial pilot | 4 tasks × 2 arms × 2 models × 2 reps ≈ 32 | shard by model |
| Support-ask | catch-rate scenarios | short |
| Bandwidth | packaging smoke first; live optional | theory check |

---

## 6. CI wiring

| Job | Content |
|-----|---------|
| `ci` (existing +) | ts/py/packaging/parity + **fuzz** + **adversarial recorded** + **library-smoke** |
| `ci:conformance` | unit + replay + parity |
| `ci:fuzz` | P1 seeded fuzz |
| `ci:adversarial` | P2 recorded matrix |
| `ci:library-smoke` | P4 example library |
| live pilots | manual/tmux; freeze under `case-studies/*/results/` |

---

## 7. Definition of done

1. `KIT_PARALLEL_N` documented (this file §3).
2. `scripts/kit-tmux-shard.mjs` used ≥ L3.
3. P1 `ci:fuzz` green.
4. P2 adversarial pack + recorded matrix + scorer `attack_block_rate`.
5. P3 ask-before-act fixtures + `examples/support-bot-ask`.
6. P4 bandwidth variants + library smoke.
7. **[`STRESS-TEST-REPORT.md`](STRESS-TEST-REPORT.md)** published (strengths / weaknesses / taxonomy crosswalk).
8. Example-library generator + browser playground **only after** the report.

---

## 8. Work items

- [x] `conformance/fuzz/` generator + TS/PY agreement runner
- [x] `case-studies/adversarial/` manifest + attack archetypes
- [x] scorer: `attack_block_rate` + CB/PC paired arms
- [x] support ask-before-act + `user.ask` host path
- [x] world bandwidth toggle + library smoke
- [x] KIT tmux shard launcher + capacity probes
- [x] Final strengths/weaknesses report
