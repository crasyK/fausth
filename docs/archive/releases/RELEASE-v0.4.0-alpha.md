# Release notes — v0.4.0-alpha (audit release)

Both engines now follow one normative contract. TypeScript and Python produce the same events,
byte for byte, for the same harness.

## What changed

1. **The contract is normative.** [`docs/spec-v0.3.md`](../../spec-v0.3.md) defines decisions D1–D16:
   - Verdicts mean what they say: a call whose verify failed is not a success and commits nothing.
   - Trust is never minted: spawn is tighten-only and charged to the parent.
   - The engine has no harness-specific names: tools declare `effects`.
   - The **user cell is real**: `channel: user` tools are answered by recorded answers, a declared simulator, or a
     human, never by the acting model.
2. **Same tokens everywhere.** The Python engine was rebuilt as a line-by-line twin of the TS runtime.
   - Conformance replay 87/87 in both engines.
   - `scripts/parity.mjs` is green in all eight sections, including 1343 schema cases and 400 runtime cases.
   - IR fuzz: semantic 30/30 in both engines, 200/200 random runs identical.
3. **Trust boundary.**
   - Signer trust store with clear verify exit codes.
   - Env allowlists for child processes; bundle-shipped commands need explicit allowance.
   - Normalized, symlink-safe scopes and protected paths.
   - No `Function()` on model input.
4. **Measurement.** Case-study graders were fixed and self-tested, and gold leakage was removed. Statistics are
   paired. Invalid claims are retracted in [`case-studies/CLAIMS-STATUS.md`](../../../case-studies/CLAIMS-STATUS.md).

## Compatibility

| Surface | Version |
|---------|---------|
| Counterbalance contract (normative) | `docs/spec-v0.3.md`; accepted spec ids `counterbalance-contract/v0.1`–`v0.3` |
| Harness bundle formats | `v0.1` · `v0.2` · `v0.3` (now admit `user.answers.jsonl`) |
| Package version | `0.4.0-alpha` (Python `0.4.0a0`) |

**Breaking changes:**
- Harnesses whose tools write undeclared state keys are denied (`state_write_denied`).
- Checkpoint/user tools need `channel: user` and a `user:` binding.
- The removed self-answering natives (`stub.ask`, `local.user_*_auto`, …) fail with an actionable error.
- Engines set state only through declared tool `effects`, not by name.

## Security disclaimer

Still **not** production-safe. World commands run agent code with the operator's uid; see
[`docs/production-isolation.md`](../../production-isolation.md).
