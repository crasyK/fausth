# Coding Counterbalance — permissive control harness

Matched ablation for the coding case study. Same tools, limits, state keys,
and mode ids as `examples/coding-counterbalance`, but **without**:

- `sequences` (plan-before-write)
- `invalidate_after` (stale test evidence on write)
- `completion.require` (fresh evidence + cleared todos)

Modes remain so both conditions share the same soft disposition surface; the
world no longer enforces the three constraints under test.
