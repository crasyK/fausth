# Audit fix status (2026-10-13)

Branch `audit/integration` = main + fix/contract + fix/edge + fix/scripts + fix/cases + fix/pytwin.
Nothing is pushed. The live checkout /home/mark/research/fausth is untouched.

## Green (2026-10-14)
- TS engine: 538/538 tests, conformance replay 87/87, `tsc --noEmit` 0 errors, `pnpm build` OK.
- Python engine: a line-by-line port of the v0.3 TS runtime (`engines/py/fausth/engine.py`); replay 87/87
  byte-identical, pytest 344/344.
- Cross-engine: `scripts/parity.mjs` "parity ok (TS ↔ Python ↔ golden)" in every section (replay 87, yaml 307,
  load 42, inspect 21, canonical 16, world 6, schema 1343, runtime 400); `scripts/fuzz-ir.mjs` 48/48 agree,
  semantic 30/30 in both engines, 200/200 random runs identical.
- Scripts: 133/133. Recorded smokes all exit 0: conformance, packaging, resolve, multi-host, local-e2e,
  adversarial, swe-recorded, tau-recorded, library-smoke, fuzz.
- Spec: `docs/spec-v0.3.md` is normative (D1–D16). KNOWN-ISSUES #47 and #55 are resolved.
- Case-study claims: `case-studies/CLAIMS-STATUS.md` (SWE grader validated on 25/25 tasks across 12 repos).

## Open
1. `fix/pytwin` holds an uncommitted `canonical.py` rewrite from the stopped agent. It is superseded by this
   branch (parity is green without it); left in its worktree, not merged.
2. werki: `origin/main` already contains company key prefixes in history. Removing them needs a history rewrite,
   which is the owner's call.
3. CI must run Python from the repo (`pip install -e engines/py` or `PYTHONPATH=engines/py`); a venv whose
   editable install points at another checkout runs the wrong engine. `FAUSTH_PYTHON` selects the interpreter.
