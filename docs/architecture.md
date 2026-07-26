# Architecture

```
agent.yml + deployment.yml
        ↓
  Canonical JSON IR  (schema-validated)
        ↓
  ┌─────┴─────┐
  engines/ts   engines/py
        ↓
  Native tool registry → world
```

## Lifecycle (v0.1 shipped)

`propose → validate → authorize → execute → verify`

Named stubs: `observe`, `record`, `rebalance`.

Verdicts: `allow` | `deny` | `safe_state`.

## Two tracks

- **Track A:** golden-log replay (`recorded` adapter) — byte-identical across TS/Py.
- **Track B:** OpenRouter free live suite — never mutates Track A expectations automatically.

Normative semantics: [`spec-v0.1.md`](spec-v0.1.md).  
Philosophy (Counterbalance Architecture): Notion *My Harness Engineering Journey*.
