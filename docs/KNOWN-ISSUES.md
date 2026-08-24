# Known issues

Tracked on GitHub: [crasyK/fausth/issues](https://github.com/crasyK/fausth/issues).

## Blockers for a green `ci:conformance`

| Issue | What |
|-------|------|
| [#47](https://github.com/crasyK/fausth/issues/47) | 8 CB goldens drift after `plan` orientation hint — replay fails |

`pnpm -C engines/ts test` is green independently of replay.

## Hygiene

| Issue | What |
|-------|------|
| [#54](https://github.com/crasyK/fausth/issues/54) | `pnpm evidence:check` not in CI |
| [#55](https://github.com/crasyK/fausth/issues/55) | Validator schema still contract v0.1; docs say v0.2 normative |

Chess-specific issues were closed when chess moved to `/home/mark/chess-harness`.

## Not bugs (accepted residuals)

- CasaOS / Lab UI live outside this repo (`/home/mark/fausth-lab`)
- SWE / τ / adversarial studies are **frozen**, not broken
