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
| **Instinct** | Agent disposition / promoted pattern. Made real by world security (permissions, sequences, hooks) and by provisioning separate harness YAMLs per role, not by prompting alone. |
| **Permission** | Hard allow/deny of capabilities or scopes. A harness YAML's `tools:` list is the capability surface — tools not listed are not offered. |
| **Hook** | Deterministic pre/post reaction shaping (inject, invalidate, require checkpoint, redirect) without granting extra capability. |
| **Subagent / role harness** | One `agent.yml` per role (e.g. research, plan, implementation). Host code loads and sequences harness dirs; Faust enforces only the active file. |
| **Exchange** | The governed loop around model proposals (observe → propose → authorize → execute → verify → record/invalidate → …). |
| **Track A** | Deterministic recorded replay; byte-identical across engines. |
| **Track B** | Live model runs; must not redefine Track A goldens. |
| **Deny signal (`failure`)** | Machine-checkable object on Counterbalance deny events (`predicate` / `missing_prior_tools` / `checkpoint_key`). Optional `unblock` names a checkpoint tool that can clear a failing `eq` state key. Normative in [`spec-v0.2.md`](spec-v0.2.md). |
