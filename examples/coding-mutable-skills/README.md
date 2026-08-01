# Coding mutable skills (locked host auto-decline on research/plan)

- **Research / plan** — no `harness.reflect_skills` tool. Host always records
  `decline.json` with `source: host_auto` after the phase (no agent bypass).
- **Implementation** — after tests pass, `harness.reflect_skills` is **required**
  before `task.complete` (`work-before-reflect`).

Force-reflect probe (agent must reflect early) lives under
`examples/coding-mutable-skills-force-reflect/`.
