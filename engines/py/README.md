# Faust Harness — Python twin

The Python engine is a twin of the TypeScript engine: for the same harness and
transcript both must emit **byte-identical canonical event logs** (`scripts/parity.mjs`
checks this). It runs Track A replay and recorded harness runs, plus the packaging
commands (`validate` / `inspect` / `resolve` / `test` / `pack` / `unpack` / `verify` /
`select` / `audit`). Live model transports for the acting agent stay on the TS host; the
Python host does support the D14 user channel (recorded, human, simulator).

```bash
python -m venv .venv && .venv/bin/pip install -e "engines/py[dev]"
PYTHONPATH=engines/py .venv/bin/python -m fausth replay [fixturesDir] [--dump-dir out/]
PYTHONPATH=engines/py .venv/bin/python -m fausth validate examples/greenhouse
PYTHONPATH=engines/py .venv/bin/python -m fausth test examples/coding-counterbalance
PYTHONPATH=engines/py .venv/bin/python -m fausth run examples/support-bot --apply-overlays --report out.json
PYTHONPATH=engines/py .venv/bin/python -m fausth verify dist/h.fausth.json --trusted-keys trusted.keys --require-trusted
```

Bundle trust / spawn flags (`--trusted-keys`, `--require-trusted`, `--allow-command`) map to
`FAUSTH_TRUSTED_KEYS`, `FAUSTH_REQUIRE_TRUSTED_BUNDLES`, `FAUSTH_ALLOW_COMMANDS`.
`verify` exits 0 accepted, 1 invalid, 2 trust-store error, 3 rejected by policy.

## Portable semantics (why the twin is not a line-by-line port)

- **Canonical JSON** (`fausth.canonical`): keys sorted by code point (D1), lengths and
  truncation in code points (D2), integral numbers (`1.0`, `1e3`) are int53 integers and
  non-integral / non-finite numbers are rejected where they enter (D3). JSON input goes
  through `json_loads` / `read_jsonl` (TS `readJsonl` line splitting).
- **YAML** (`fausth.registry.load_yaml`): YAML 1.2 core schema identical to the TS `yaml`
  package (D4) — `yes/no/on/off` stay strings, no timestamps or sexagesimal numbers,
  duplicate keys rejected, `<<` is a plain key.
- **JS value semantics** where values reach the log: `??`, truthiness, `String()`,
  `Number()`, `undefined` vs `null` (`fausth.canonical.UNDEFINED`).
- **Schemas** (`fausth.schema_validate`): Ajv semantics incl. every `ajv-formats` full
  format and JavaScript `pattern` regexes; compiled validators are cached. Missing
  `additionalProperties` means *false* for tool I/O schemas (spec v0.1 §5.1).
- **Decisions in the runtime**: permissions `[]` = none (D5); spawn needs `spawn.allow:
  true`, is permission-gated and charged to the parent (D6); D7 path/scope normalization;
  a call succeeds only if executed *and* verified, otherwise its transition is discarded
  (`failure.kind: transition_discarded`, D8); checkpoint authority at authorize (D9);
  recovery takes the governed path (D10); no harness-specific names in the engine (D11);
  user cell only via a host user channel (D14); predicate paths resolve own keys only (D16).
- `run_loop(None)` leaves the step budget to the IR limits (TS `runLoop(Infinity)`).

Schemas are located via `$FAUSTH_SCHEMA_DIR`, the repository `schema/` directory, or the
package-data copy in `fausth/schema/` (kept identical by a test).

Normative reference: `docs/spec-v0.1.md` … `docs/spec-v0.3-draft.md`.
