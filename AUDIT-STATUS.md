# Audit fix status (2026-10-13)

Branch `audit/integration` = main + fix/contract + fix/edge + fix/scripts + fix/cases + fix/pytwin.
Nothing is pushed. The live checkout /home/mark/research/fausth is untouched.

## Green
- TS engine: 536/536 tests, conformance replay 87/87, `tsc --noEmit` 0 errors, `pnpm build` OK.
- Spec: `docs/spec-v0.3.md` is normative (decisions D1–D16). KNOWN-ISSUES #47 and #55 are resolved.
- Done per branch:
  - edge: trust store, sandbox, user channel, transport;
  - scripts: runner, stats, CI;
  - contract: spec, runtime, schema, goldens, examples;
  - cases: faithful τ world, safe calculate, SWE grader, retracted claims, v0.3 harnesses.
  Details are in each branch's commits.

## Open
1. **Python port of spec v0.3.** fix/pytwin implemented the decisions in Python, but its event shapes are not yet
   reconciled with the v0.3 goldens. Python replay is 17/87, so TS↔Python parity (`scripts/parity.mjs`) is red.
   Five Python tests fail on cross-engine tables:
   - test_bundle: pack/validate/unpack test
   - test_bundle: unsigned coding pack size
   - test_registry: native table matches TS
   - test_schema_location: packaged schema copy matches repo schema
   - test_world_cross_engine: default worlds identical across engines
2. **Five script tests** (case-study-deployments: user-channel bindings D14; SCR-4 KIT materialization) expect
   pre-migration τ harness shapes. Reconcile them with fix/cases' v0.3 harnesses.
3. **Uncommitted WIP** left in worktrees when the agents were stopped:
   - fausth-edge: 9 files, an extra item after round 3;
   - fausth-cases: 1 file;
   - fausth-pytwin: `engines/py/fausth/canonical.py`, port in progress.
4. **werki:** `origin/main` already contains company key prefixes in history. Removing them needs a history rewrite,
   which is the owner's call.
