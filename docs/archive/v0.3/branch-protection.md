# Branch protection baseline (alpha)

Protect `main` so release claims stay reproducible while live-provider noise stays non-blocking.

Recommended required checks:

- `ts`
- `py`
- `parity`
- `packaging`

Keep live Track B jobs (`live-openrouter`) non-blocking because provider behavior is outside harness determinism.

Recommended repository settings:

- Require a pull request before merging.
- Require at least one approval.
- Dismiss stale approvals on new commits.
- Require status checks to pass before merging.
- Restrict force pushes and branch deletion on `main`.

Pin discipline for external host workflows:

```bash +code
# Verify both SLOPATHON example workflows pin the same fausth SHA.
node scripts/release-check.mjs
```

When publishing a release:

```bash +code
# 1) update example host workflow refs to release SHA
# 2) run packaging + parity + release-check
pnpm ci:packaging
node scripts/parity.mjs
node scripts/release-check.mjs
```
