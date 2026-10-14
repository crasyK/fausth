# Known issues

Tracked on GitHub: [crasyK/fausth/issues](https://github.com/crasyK/fausth/issues).

## Resolved in 0.4.0-alpha

| Issue | What | Resolution |
|-------|------|------------|
| [#47](https://github.com/crasyK/fausth/issues/47) | 8 CB goldens drifted after the `plan` orientation hint | Orientation is generic (D11); goldens re-derived from `docs/spec-v0.3.md`; replay 87/87 in both engines |
| [#54](https://github.com/crasyK/fausth/issues/54) | `pnpm evidence:check` not in CI | Runs in the `ci` workflow |
| [#55](https://github.com/crasyK/fausth/issues/55) | Validator schema still contract v0.1 while docs said v0.2 | `docs/spec-v0.3.md` is normative; one IR accepts spec ids v0.1–v0.3; closed schema |

## Open

- The v0.2 **agent/world/exchange** authoring shape is a non-loadable draft (translation plan in
  `docs/spec-v0.3-draft.md` §A).
- World commands (`shell.run_allowlisted`) run agent code with the operator's uid. They get an env allowlist and
  a private HOME, but they are **not a sandbox** (`docs/production-isolation.md`).
- The Python engine has no live user-simulator smoke yet; recorded and human sources are tested.

## Not bugs (accepted residuals)

- Chess lives in the separate consumer `chess-harness`. CasaOS / Lab UI live outside this repo.
- Case-study numbers from before 0.4.0 are history only. See `case-studies/CLAIMS-STATUS.md` for what may be claimed.
