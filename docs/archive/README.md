# Archived documentation

Point-in-time snapshots that are **not** the current entry path. Canonical history lives in [`CHANGELOG.md`](../../CHANGELOG.md). Canonical specs live at `docs/spec-v0.*.md`.

| Folder | Contents |
|--------|----------|
| [`releases/`](releases/) | Narrative notes for `v0.1.2`–`v0.3.0` alphas |
| [`specs/`](specs/) | Superseded `spec-v0.2-draft.md` redirect |
| [`recon/`](recon/) | Deferred recon (Kaggriculture) |

## Local-only live archive

Raw run dumps are gitignored. After the 2026-08 deep clean:

- **Moved off the hot path:** `live/archive/` (KIT probe, HRI gemma bundle, SWE opt-arms v1/v2, Lab UI ghost logs)

`live/cache/` (SWE-bench checkouts) is also gitignored. Regenerable; do not commit.
