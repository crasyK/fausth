# Faust Harness (`fausth`)

A harness file declares what a model sees: the prompt, the tools, and the hooks that check
every step. Two small engines (TypeScript and Python) run the same file and must produce
byte-identical logs and model requests.

**Status:** under construction on branch `build/spec-v0.4`. The source of truth is
[`docs/spec-v0.4-draft.md`](docs/spec-v0.4-draft.md); the build follows
[`docs/build-plan-v0.4.md`](docs/build-plan-v0.4.md). Not production-safe.

The previous system (spec v0.1–v0.3, release `v0.4.0-alpha`) is retired. Its code stays
reachable through the [`v0.4.0-alpha`](https://github.com/crasyK/fausth/releases/tag/v0.4.0-alpha)
tag; its documents are in [`docs/archive/`](docs/archive/).

## Layout

```
docs/          spec-v0.4-draft.md (normative once released), build plan, design notes
engines/ts/    TypeScript engine
engines/py/    Python engine
```

## Quick start

```bash
corepack enable && pnpm install   # Node 22+
pnpm test                         # TypeScript engine
pip install -e "engines/py[dev]" && pytest engines/py/tests -q
```

## License

Apache-2.0 — `LICENSE` · `NOTICE`
