# Faust Harness (`fausth`)

A harness file declares what a model sees: the prompt, the tools, and the hooks that check
every step. Two small engines (TypeScript and Python) run the same file and must produce
byte-identical logs and model requests.

**Status:** release 0.5.0 implements [`docs/spec-v0.5.md`](docs/spec-v0.5.md), the normative
spec: both engines reproduce every fixture in [`conformance/`](conformance/) byte for byte. Built
along [`docs/build-plan-v0.4.md`](docs/build-plan-v0.4.md). Not production-safe.

The previous system (spec v0.1–v0.3, release `v0.4.0-alpha`) is retired. Its code stays
reachable through the [`v0.4.0-alpha`](https://github.com/crasyK/fausth/releases/tag/v0.4.0-alpha)
tag; its documents are in [`docs/archive/`](docs/archive/).

## Layout

```
docs/          spec-v0.5.md (normative), build plan, design notes
engines/ts/    TypeScript engine (+ OpenAI-compatible adapter)
engines/py/    Python engine (+ adapter, command-line host, python-chess tools)
hosts/web/     the browser host: one HTML page with the TS engine and chess.js tools
conformance/   shared vectors and recorded fixtures both engines must reproduce
examples/      the chess harness (spec §2) with a KIT deployment
```

## Quick start

```bash
corepack enable && pnpm install   # Node 22+
pnpm test                         # TypeScript engine
pip install -e "engines/py[dev]" && pytest engines/py/tests -q
```

## Play the chess harness (Python host)

```bash
pip install -e "engines/py[chess]"
export KIT_AI_API_KEY=...            # the key stays in the environment
python -m fausth run examples/chess/harness.yaml --deployment examples/chess/deployment.kit.yaml \
  --user "Play the best move for White." --log run.log.jsonl
```

`examples/chess/harness.yaml` is the spec's §2 harness. The deployment binds its tools to
python-chess (`fausth.chess_tools`) and names the model; see `engines/py/fausth/host.py` for the
binding kinds (`script`, `recorded`, `model`).

## Play it in the browser (TypeScript host)

```bash
pnpm -C hosts/web build      # writes hosts/web/dist/index.html, one self-contained page
```

Open `hosts/web/dist/index.html`. It replays every conformance fixture with the TS engine (the
same bytes as the Python engine), and it plays `examples/chess/harness.yaml` live with chess.js
tools. Paste a key for an endpoint that accepts browser calls: OpenRouter does; the KIT gateway
allows only its own origin. `pnpm -C hosts/web check` replays the fixtures in headless Chrome.

## License

Apache-2.0 — `LICENSE` · `NOTICE`
