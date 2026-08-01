# Coding mutable skills — **force-reflect** variant

Same pipeline as `coding-mutable-skills`, but research/plan **must** call
`harness.reflect_skills` before `phase.yield` (no silent host-auto skip-out).

- Research: `reflect-before-yield`
- Plan: `approve-before-reflect` then `reflect-before-yield`
- Implementation: unchanged (`work-before-reflect` + `reflect-before-complete`)

Used to probe whether models can handle required early-phase reflection vs
optional + host auto-decline.
