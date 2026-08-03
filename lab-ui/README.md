# Fausth Lab UI

Minimal run orchestrator for CasaOS / local Docker. Reuses existing CLIs — not a second engine.

## Run locally (without Docker)

```bash
cd /path/to/fausth
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use
node lab-ui/server.mjs
# → http://127.0.0.1:8787
```

Optional: `FAUSTH_LAB_TOKEN=…` requires `Authorization: Bearer …`.

## What it does

| Action | CLI under the hood |
|--------|--------------------|
| Track A test | `pnpm -C engines/ts exec node --import tsx src/cli.ts test <world>` |
| Recorded case-study | `node scripts/case-study-coding.mjs --mode recorded …` |
| Repo conformance | `pnpm ci:conformance` |

Worlds are discovered from [`worlds/*/world.yml`](../worlds/).

## Phase 2 — Cursor SDK world designer

**Not implemented in MVP.** Planned flow:

1. Lab UI button **Draft world with agent**.
2. Server calls `@cursor/sdk` (`Agent.create` / `Agent.prompt`) with `local.cwd` = mounted Fausth repo (or a cloud clone).
3. Prompt contract: create/update `worlds/<id>/` + harness YAML + seed fixtures per [`docs/authoring.md`](../docs/authoring.md) and counterbalance allow-list rules.
4. New worlds land as `status: draft`; Lab only auto-lists **approved** worlds for live/KIT by default (MVP lists all; tighten later).
5. Human reviews the draft in **Cursor on the host**, merges, then Lab runs the reviewed world.

Chess and other heavy worlds should be authored this way once the SDK path exists — see [`worlds/chess/README.md`](../worlds/chess/README.md).

## Deploy

See [`deploy/casaos/README.md`](../deploy/casaos/README.md).
