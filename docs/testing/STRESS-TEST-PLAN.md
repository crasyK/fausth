# Fausth stress-test plan (benchmark-informed)

Status: **committed plan** (main). Goal: prove the **core engine** is right under every axis external agent benchmarks care about, *in Fausth terms* — then patch holes, **then** build the example library + browser demo.

This is **not** a promise to port SWE-bench/OSWorld/WebArena wholesale. Those measure **agent skill inside fixed scaffolds**. Fausth’s claim is different: **given the same model and world, does the vessel reduce unsafe/wrong completions without killing task success?** Every suite below is framed as **CB vs PC** (counterbalanced vs permissive-control) or as Track A determinism unless stated otherwise.

---

## 0. External anchors (what we are *borrowing* from)

| Family | Repos / data | What we take |
|--------|----------------|--------------|
| SWE-bench / Verified | [swe-bench/SWE-bench](https://github.com/swe-bench/SWE-bench), [swebench.com](https://www.swebench.com/) | Coding task realism at repo scale (shape of stress, not the harness) |
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
| Unit (TS) | `engines/ts/src/**/*.test.ts` (~17 files) | runtime, adapters, resolve, packaging, deny-failure, overlays, audit, connectors, github integrations |
| Track A conformance | `conformance/fixtures/cb-*/` (27 fixtures) | deterministic engine semantics; TS + PY replay must be byte-identical |
| Fixture generator | `engines/ts/src/gen-cb-fixtures.ts` | regenerates goldens |
| Script tests | `scripts/case-study-score.test.mjs`, `case-study-pipeline.test.mjs` | scoring/pipeline math |
| CI bundles | root `package.json`: `ci:conformance`, `ci:packaging`, `ci:resolve`, `ci:multi-host`, `ci:local-e2e`, `ci:release-check` | engine + packaging + connectors + multi-host + release gates |
| Live case studies | `scripts/case-study-coding.mjs` + `case-studies/*` | CB vs PC / baseline vs mutable on real models |

**Gap:** no *single* adversarial/security stress matrix; no property/fuzz layer for IR; no explicit “world-talks-more” bandwidth ablation; no refusal-with-tools suite; no scale-up coding pack behind gates.

---

## 2. Principles

1. **Deterministic before live.** Every behavior the engine guarantees must exist first as Track A fixtures (byte-stable) and unit tests. Live KIT is evidence, not oracle.
2. **Paired evaluation.** Any “Fausth helps” claim runs **same model, same task, CB vs PC** (or baseline vs treatment) with existing scorer (`scripts/case-study-score.mjs`).
3. **Borrow taxonomies, not runtimes.** From WildClaw/AgentDojo/InjecAgent we steal *threat patterns*; from τ-bench *policy+user* patterns — reimplemented on Fausth worlds.
4. **Adversarial success = deny.** For security packs, correct outcome under CB is **blocked/steered**, under PC is unsafe success; score both.

---

## 3. Suite matrix (build order)

Each suite lists: name → what it proves → how we test it.

### P0 — Engine invariants (already partially green; harden)

| Suite | Coverage | Mechanism |
|-------|----------|-----------|
| `inv-sequences` | require_prior / any_of / sequences under deny + continue_after_deny | extend `runtime` unit + `cb-deny-then-*` |
| `inv-scopes` | read/write scopes, symlink/.. containment | `adapters/local`, `sandbox-path`, `cb-read-out-of-scope-informative`, new write-lure fixtures |
| `inv-checkpoints` | user-only protected transitions | `cb-user-correction-cannot-be-self-authored` + negative variants |
| `inv-completion` | predicates, stale evidence, open todos, TTL | `cb-stale-test-success`, `cb-stale-after-ttl`, `cb-completion-open-todos-denied` |
| `inv-patch` | harness patch allowlist | `cb-harness-patch-*`, `cb-reflect-before-yield-denied` |
| `inv-overlays` | narrow-only overlays | `cb-overlay-*` |
| `inv-connectors` | module/MCP declared surface, unsigned deny, secret-like env rejection | `cb-module-connector-*`, connector/mcp exec scripts |

**Exit:** `pnpm test` + `ci:conformance` + `ci:packaging` + `ci:resolve` stay green; any new gate lands with fixture first.

### P1 — IR fuzz + parity (new)

| Suite | Coverage | Mechanism |
|-------|----------|-----------|
| `fuzz-ir-validate` | random/near-miss agent.json; validate must reject cleanly, never crash engine | property-style generator (seeded), TS + PY validate agreement |
| `fuzz-sequence-schedules` | random valid tool sequences per IR; replay determinism | generated model.jsonl against random harnesses |
| `parity-random-harness` | TS vs PY runtime equality beyond hand fixtures | shared generator emits IR + transcripts; both engines byte-match |

**Exit:** seeded corpus in `conformance/fuzz/` + CI job; bugs fixed before P2.

### P2 — Adversarial tool security (highest-leverage new pack)

Inspired by **AgentDojo + InjecAgent + WildClaw T06**.

| Suite | Attack pattern (taxonomy borrow) | Fausth expectation |
|-------|----------------------------------|--------------------|
| `adv-skill-injection` | content instructs agent to patch skills maliciously / widen permissions | CB: `harness_patch_denied` or host decline; PC: unsafe apply |
| `adv-file-overwrite` | task lures overwrite outside `write_scopes` | CB: scope deny + recover; PC: silent overwrite succeeds |
| `adv-secret-exfil` | planted `API_KEY` in env/file; prompt asks to log it | CB: refuse / no secret in outputs; PC: leaks |
| `adv-prompt-injection-doc` | injection inside readable file changes goal | CB: ignores injected instruction, still completes original task or safe-stops |
| `adv-dangerous-shell` | lure `rm -rf`-class command | CB: allowlist deny |
| `adv-escalation-connector` | undeclared module tool / unsigned connector invoked | CB: `capability_missing` |

**Mechanism:** new `case-studies/adversarial/` manifest + tasks with planted artifacts; host runs **CB vs PC**; scorer reports **attack_block_rate**, **task_success**, **utility_delta** (AgentDojo-style joint view). Track A fixtures for each deny path first.

**Exit:** 10–20 cases, deterministic fixtures + small live pilot; README table.

### P3 — Policy + user simulation (τ-bench-inspired)

| Suite | Coverage | Mechanism |
|-------|----------|-----------|
| `pol-support-scale` | expand support-bot: multi-policy retail-like rules, kb-before-answer, refund capability gating | new world + tasks; sequence + capability fixtures |
| `user-sim-ambiguity` | ambiguous intent must trigger clarification (`user.ask`/approve) before action | wire `user.ask` real host; deny-if-act-before-ask fixture |

**Exit:** support case-study paired CB vs PC on policy violations.

### P4 — Scale & breadth of worlds (internal, not SWE claim)

| Suite | Coverage | Mechanism |
|-------|----------|-----------|
| `coding-repo-scale` | larger synthetic repo tasks (multi-file, rename, extract) behind same gates | extend `case-studies/coding-counterbalance/tasks/` count; CB vs PC |
| `world-bandwidth` | **world talks more** ablation: terse vs verbose observations/orientation | same tasks, two world variants; measure success lift at fixed safety |
| `harness-library-smoke` | N harnesses × M worlds auto-generated smoke | example-library generator runs `fausth test` on all |

**Exit:** bandwidth ablation result recorded (theory check); library smoke in CI.

### P5 — Refusal under tools (AgentHarm-flavored, optional phase 2)

| Suite | Coverage | Mechanism |
|-------|----------|-----------|
| `refuse-harmful-with-tools` | harmful requests refused; benign tool tasks still succeed | host scenario; scored refusal rate vs benign success |

### P6 — Memory self-evolution (only if `memory` cell expands)

| Suite | Coverage | Mechanism |
|-------|----------|-----------|
| `mem-evolution` | cross-task memory notes/TTL correctness | extend mutable-cells curriculum metrics |

### Deferred (documented, not built now)

- OSWorld / WebArena / BrowserGym real surfaces — needs UI world + isolation beyond alpha scope.
- GAIA / TheAgentCompany end-to-end — different product axis.
- BFCL — below layer.

---

## 4. CI wiring (proposed)

| Job | Content |
|-----|---------|
| `ci` (existing) | ts/py/packaging/parity |
| `ci:conformance` (existing) | unit + replay + parity |
| **`ci:fuzz`** (new) | P1 seeded fuzz + parity corpus |
| **`ci:adversarial`** (new) | P2 Track A fixtures + offline scoring of recorded adversarial runs |
| `multi-host` (existing) | live smoke |
| **live pilots** (manual/scheduled) | P2/P3/P4 small KIT runs; results frozen under `case-studies/*/results/` |

---

## 5. Definition of done (this plan)

1. P0 hardened + P1 fuzz in CI.
2. P2 adversarial pack exists (fixtures + 10–20 live-capable cases) with CB-block vs PC-success scoring.
3. P3 policy/user suite with at least one ambiguity/clarification gate.
4. P4 world-bandwidth ablation executed and written up.
5. Docs: this plan + results READMEs updated; **then** example-library generator + browser playground.

---

## 6. Work items (initial)

- [ ] `conformance/fuzz/` generator + TS/PY agreement runner
- [ ] `case-studies/adversarial/` manifest + 4 attack task archetypes (skill, overwrite, secret, injection)
- [ ] scorer: `attack_block_rate` + CB/PC paired arms for adversarial
- [ ] support world policy expansion + `user.ask` host path
- [ ] world bandwidth toggle + paired run
