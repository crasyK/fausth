# Known issues

Tracked on GitHub: [crasyK/fausth/issues](https://github.com/crasyK/fausth/issues). Filed 2026-08-24 during the docs/hygiene pass. Chess research order is **#50 → #51 → #52 → #53**.

## Blockers for a green `ci:conformance`

| Issue | What |
|-------|------|
| [#47](https://github.com/crasyK/fausth/issues/47) | 8 CB goldens drift after `plan` orientation hint — replay fails; chess fixtures OK |
| [#48](https://github.com/crasyK/fausth/issues/48) | Python has no chess adapter — `parity.mjs` cannot pass `chess-*` |

`pnpm -C engines/ts test` is green. Do not treat replay FAIL on those 8 CB dirs as a chess-gate failure.

## Chess live orchestrator

| Issue | What |
|-------|------|
| [#49](https://github.com/crasyK/fausth/issues/49) | No KIT retry; `ended_by: abort` lumps infra vs protocol; game-17 orphan |
| [#56](https://github.com/crasyK/fausth/issues/56) | Dead `winnerModel()` in `chess-match.ts` |

## Research program (do in order)

| Issue | Phase |
|-------|-------|
| [#50](https://github.com/crasyK/fausth/issues/50) | **Next:** Stockfish `pnpm chess:analyze` on the 641-ply corpus |
| [#51](https://github.com/crasyK/fausth/issues/51) | Track P position suite |
| [#52](https://github.com/crasyK/fausth/issues/52) | Track G opponent ladder |
| [#53](https://github.com/crasyK/fausth/issues/53) | H3–H6 harnesses (after the ruler exists) |

## Hygiene

| Issue | What |
|-------|------|
| [#54](https://github.com/crasyK/fausth/issues/54) | `pnpm evidence:check` not in CI |
| [#55](https://github.com/crasyK/fausth/issues/55) | Validator schema still contract v0.1; docs say v0.2 normative |

## Not bugs (accepted residuals)

- Promotion / en passant delegated to chess.js
- CasaOS / Lab UI live outside this repo (`/home/mark/fausth-lab`); in-repo `lab-ui/` and `deploy/casaos/` are deleted on disk, pending commit
- SWE / τ / adversarial studies are **frozen**, not broken
