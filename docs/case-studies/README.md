# Case studies

Bounded empirical studies of Fausth harnesses. Method:
[`PROTOCOL.md`](PROTOCOL.md).

| Study | Domain | Status | Evidence |
|-------|--------|--------|----------|
| Coding Counterbalance | Local coding agent | Live pilot published (`live-kit-v3-reduced`) | HRI Track C · [`PROTOCOL.md`](PROTOCOL.md) |
| SWE-bench Lite | Real repo checkouts | HRI Track S smoke frozen (`hri-swe-v1-l1-gemma`); N=25 imported | [`case-studies/swe-bench/`](../case-studies/swe-bench/) |
| τ-bench retail | Policy + tools + user.ask | HRI Track T: N=25 claim 80% (`cb-todo-delegate`); full retail curiosity 70.4% | [`case-studies/tau-bench/`](../case-studies/tau-bench/) · [N=25 report](../case-studies/tau-bench/results/HRI-T-TODO-DELEGATE-REPORT.md) · [full/levers](../case-studies/tau-bench/results/HRI-T-FULL-RETAIL-AND-LEVERS-REPORT.md) |
| Adversarial security | WildClaw / AgentDojo patterns | Live `adv-live-v3` frozen | HRI Track A · [`PROVENANCE.md`](../case-studies/adversarial/PROVENANCE.md) |
| Harness Reliability Index | Cross-track CB vs PC | `hri-v0` frozen | [`docs/testing/HRI.md`](../testing/HRI.md) · `pnpm hri:aggregate` |
| Mutable cells + overlays | Self-edit skills + model overlays | Scaffolded | [`MUTABLE-CELLS-PROPOSAL.md`](MUTABLE-CELLS-PROPOSAL.md) |
| Support bot | Policy sequences | Folded into HRI Track T (τ-bench); examples remain | [`examples/support-bot-ask/`](../examples/support-bot-ask/) |
| Greenhouse | Effect / budget verify | Mechanism demo | [`examples/greenhouse/`](../examples/greenhouse/) |
| SLOPATHON CI gate | PR quality host surface | Existing field trial | [`examples/slopathon-review/VERIFICATION.md`](../examples/slopathon-review/VERIFICATION.md) |

Greenhouse and SLOPATHON remain valuable proofs of different claims
(effect verification; real-repo CI gating). They are not re-labeled as
equivalent to the coding pilot until they reuse this protocol.
