# Faust Harness — Python twin

Track A golden-log **replay** plus harness packaging commands (`run` / `test` / `inspect` / `pack`) for recorded deployments. Live model transports remain on the TypeScript CLI.

```bash
pip install -e ".[dev]"
python -m fausth replay
python -m fausth test examples/coding-counterbalance
python -m fausth inspect examples/support-bot
python -m fausth pack examples/coding-counterbalance --out live/reports/out.fausth.json
```

Normative reference: `docs/spec-v0.1.md` (not a port of the TypeScript source line-by-line).
