# Glossary

| Term | Meaning |
|------|---------|
| **Harness** | Portable contract describing one reaction: agent side + world side (today often authored as `agent.yml`). |
| **Agent** | Soft side of the exchange: skills (what it can attempt), memory (what it believes), instincts (promoted behaviour patterns). |
| **World** | Hard side of the exchange: gates (proof), user checkpoints (correction/authority), security (permissions, hooks, sequences; capability surfaces via harness tool lists). |
| **Deployment** | Local binding: model transport, native tool bindings, platform limits. Must not weaken harness security. Bindings are resolved by the host; missing/unknown natives are adapter failures. |
| **Adapter** | Environment implementation of world operations (`observe`, `execute`, `capture_evidence`, `request_user`, …). Distinct from harness policy: adapter failure ≠ authorize deny. |
| **Skill** | Declared agent capability / tool id the model may propose. |
| **Gate** | World check that an attempted ability is allowed and/or that its outcome is acceptable (authorize + verify). |
| **Memory** | Agent’s portrayed reality (state, observations, plans, to-dos) with provenance and freshness. |
| **User checkpoint** | World-mediated user interaction that can approve, correct, invalidate, redirect, or stop — not only approve. |
| **Instinct** | Agent disposition / promoted pattern. Written as the harness's `instinct_text` (rendered verbatim as system context by every host, spec-v0.3 §15.3) and made real by world security (permissions, sequences) and per-role harness YAMLs, not by prompting alone. |
| **Permission** | Hard allow/deny of capabilities or scopes. A harness YAML's `tools:` list is the capability surface — tools not listed are not offered. |
| **Hook** | Deterministic pre/post reaction shaping (inject, invalidate, require checkpoint, redirect) without granting extra capability. |
| **Subagent / role harness** | One `agent.yml` per role (e.g. research, plan, implementation). Host code loads and sequences harness dirs; Faust enforces only the active file. |
| **Exchange** | The governed loop around model proposals (observe → propose → authorize → execute → verify → record/invalidate → …). |
| **Track A** | Deterministic recorded replay; byte-identical across engines. |
| **Track B** | Live model runs; must not redefine Track A goldens. |
| **Deny signal (`failure`)** | Machine-checkable object on deny events from a closed set of kinds (`predicate`, `missing_prior_tools`, `missing_prior_any_of`, `checkpoint_key`, `state_key`, `non_canonical`, `channel_unbound`, `transcript`, `adapter`, `spawn`, `harness_patch`, …). Optional `unblock` names a checkpoint tool that can clear a failing `eq` state key. Engines never emit prose hints. Normative in [`spec-v0.3.md`](spec-v0.3.md) §13.3. |
| **Success** | A call is successful only if it executed **and** every verify passed; only then is its state transition committed (spec-v0.3 §6.5). A run succeeded iff it recorded `run_complete`. |
| **User channel** | Tools declared `channel: user` are answered by recorded answers (Track A), a declared simulator or a human — never synthesized from the model's own arguments. Unbound ⇒ `capability_missing`. User decisions are checkpoint keys only their user tool may write (spec-v0.3 §9, §8.3). |
| **Declared effects** | Tool `effects: [{when?, set}]`: the harness (not the host, not the engine) says what a result means for memory, e.g. tests passing ⇒ `test_evidence_current: 1` (spec-v0.3 §6.3). |
| **Infrastructure failure** | Host adapter failure (`infra_failure`, failure kind `adapter`) or model-transport error: reported apart from model behaviour, ends the run, excluded from model metrics. |
| **Cannot / may not / did not** | Control timing: design-time capability absence; pre-execution authorize/sequence deny; post-execution evidence/absence/output verify. See [`notion-hub/control-timing.md`](notion-hub/control-timing.md). |
| **Deny telemetry** | Closed reason codes and structured `failure` objects treated as a measurement grammar (`fausth audit`). Security hides disposition; gates reveal it. |
| **Output verify** | `kind: output` — predicates on assistant/tool message content (`message.contains_code_fence`, …). Reason: `verify_output_failed`. Normative: [`spec-v0.3.md`](spec-v0.3.md) §7, §8.6. |
| **Memory provenance** | Per-key status (`current` \| `stale` \| `contradicted` \| `unknown`), source, and `updated_at_step`. Enables mutation and TTL invalidation. |
| **Intervention budget** | Max harness activations per window (`run` \| `host_day`). Host-persisted for cross-run; engine emits `budget_exceeded` record events. |
| **Mutable cells** | Agent-side cells that may be self-edited (`skills` → tool descriptions; optionally `memory` / `instincts`). Security and checkpoints remain immutable. See [`self-improving-harnesses.md`](self-improving-harnesses.md). |
