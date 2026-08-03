# Fausth Lab on CasaOS

24/7 **run / author surface** for harnesses and worlds. Engine development stays on the **host in Cursor**; this container runs Track A, case studies, and (later) world drafts.

| Surface | Role |
|---------|------|
| Cursor on host | Engine, schemas, fixtures, PRs |
| CasaOS `fausth-lab` | Long-running tests, live KIT shards, Lab UI |

## Quick start (Docker Compose)

From the repo root (or CasaOS Custom App with this compose):

```bash
cd /path/to/fausth
# Ensure .env has KIT_AI_API_KEY / OPENROUTER_API_KEY as needed
docker compose -f deploy/casaos/docker-compose.yml up -d --build
```

Open **http://\<casaos-host\>:8787**.

Optional LAN token:

```bash
export FAUSTH_LAB_TOKEN=your-secret
docker compose -f deploy/casaos/docker-compose.yml up -d
# UI / API: Authorization: Bearer your-secret  (or ?token=)
```

## CasaOS Custom App

1. Apps → **Install a customized app** (or Docker Compose).
2. Use [`docker-compose.yml`](docker-compose.yml); set `env_file` to the host path of Fausth `.env`.
3. Bind-mount the repo at `/app` so Cursor edits on the host appear immediately.
4. Publish port **8787**.
5. Restart policy: unless-stopped.

## Sync workflow

1. Develop on the host with Cursor (`/home/mark/fausth` or your clone).
2. Lab bind-mounts the same tree → no image rebuild for harness/YAML changes.
3. Rebuild the image only when Node/Python deps or `lab-ui` base change.
4. Artifacts land under `live/reports/` and `case-studies/*/results/` (also volume-backed).

## Reproduce adversarial live (same as host)

Inside the container or via Lab UI “case-study”:

```bash
node scripts/kit-tmux-shard.mjs launch --level 2 --run-id-prefix adv-live-v1 \
  --manifest case-studies/adversarial/manifest.yml \
  --tasks adv-file-overwrite,adv-dangerous-shell,adv-prompt-injection-doc,adv-secret-exfil --reps 2
```

## Phase 2 — Cursor SDK world drafts

Not in MVP. See [Lab UI README](../../lab-ui/README.md#phase-2--cursor-sdk-world-designer).

## Security

MVP assumes a **trusted LAN**. Do not expose 8787 to the public internet without `FAUSTH_LAB_TOKEN` and a reverse proxy.
