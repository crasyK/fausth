# Glossary

| Term | Meaning |
|------|---------|
| **Harness** | Portable contract describing one reaction: agent side + world side (today often authored as `agent.yml`). |
| **Agent** | Soft side of the exchange: skills (what it can attempt), memory (what it believes), instincts (promoted behaviour patterns). |
| **World** | Hard side of the exchange: gates (proof), user checkpoints (correction/authority), security (permissions, modes, hooks, sequences). |
| **Deployment** | Local binding: model transport, native tool bindings, platform limits. Must not weaken harness security. Bindings are resolved by the host; missing/unknown natives are adapter failures. |
| **Adapter** | Environment implementation of world operations (`observe`, `execute`, `capture_evidence`, `request_user`, …). Distinct from harness policy: adapter failure ≠ authorize deny. |
| **Skill** | Declared agent capability / tool id the model may propose. |
| **Gate** | World check that an attempted ability is allowed and/or that its outcome is acceptable (authorize + verify). |
| **Memory** | Agent’s portrayed reality (state, observations, plans, to-dos) with provenance and freshness. |
| **User checkpoint** | World-mediated user interaction that can approve, correct, invalidate, redirect, or stop — not only approve. |
| **Instinct** | Agent disposition / promoted pattern. Made real by world security (permissions, modes, sequences, hooks), not by prompting alone. |
| **Permission** | Hard allow/deny of capabilities or scopes. |
| **Hook** | Deterministic pre/post reaction shaping (inject, invalidate, require checkpoint, redirect) without granting extra capability. |
| **Mode** | World phase that changes available actions (e.g. research, plan, implementation, verification). |
| **Exchange** | The governed loop around model proposals (observe → propose → authorize → execute → verify → record/invalidate → …). |
| **Track A** | Deterministic recorded replay; byte-identical across engines. |
| **Track B** | Live model runs; must not redefine Track A goldens. |
