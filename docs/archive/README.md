# Archived documentation

Point-in-time snapshots that are **not** the current entry path. Canonical history lives in [`CHANGELOG.md`](../../CHANGELOG.md). Canonical specs live at `docs/spec-v0.*.md`.

| Folder | Contents |
|--------|----------|
| [`releases/`](releases/) | Narrative notes for `v0.1.2`–`v0.3.0` alphas |
| [`specs/`](specs/) | Superseded `spec-v0.2-draft.md` redirect |
| [`recon/`](recon/) | Deferred recon (Kaggriculture) — revisit after chess research chapters land |

## Local-only live archive

Raw run dumps are gitignored. After the 2026-08 deep clean:

- **Keep working:** `live/reports/chess-series/` (641-ply traces for `chess:analyze`)
- **Moved off the hot path:** `live/archive/` (early chess smoke, KIT probe, HRI gemma bundle, SWE opt-arms v1/v2, Lab UI ghost logs)

`live/cache/` (SWE-bench checkouts) is also gitignored. Regenerable; do not commit.
