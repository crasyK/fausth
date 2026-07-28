## What changed

- 

## Why

- 

## Verification

- [ ] `pnpm -C engines/ts test`
- [ ] `python -m pytest engines/py/tests -q`
- [ ] `node scripts/parity.mjs`
- [ ] If harness/deployments changed: `pnpm ci:packaging`

## Risk checks

- [ ] No secrets added
- [ ] Counterbalance fixtures or smoke expectations updated when needed
