# Case study: Coding Counterbalance

Bounded live evidence that Fausth can provision **role-specific tool surfaces**
(subagent YAMLs) under a disposable worktree, compared to a matched permissive
ablation. This does **not** claim universal agent safety.

Companion: [`VERIFICATION.md`](VERIFICATION.md).  
Method: [`docs/case-studies/PROTOCOL.md`](../../docs/case-studies/PROTOCOL.md).

## Hypothesis

On fixed local coding tasks, a pipeline of research → plan → implementation
harnesses (each YAML listing only its allowed tools) should:

1. Preserve or improve **task success** vs a single open harness.
2. Shape work through **capability absence** (no write tool until implementation).
3. Enforce **evidence gates** on completion in the implementation harness.

## Method (v0.3)

- **8 tasks** under disposable linked worktrees.
- **Counterbalanced:** host runs `agents/research` → `agents/plan` → `agents/implementation`.
- **Permissive:** one open YAML with the full tool set.
- **Models:** `kit.gemma4-31b-it` + `kit.minimax-m2.7-229b`, T=0.7, 5 reps.
- Primary truth = held-out `grade/` tests. Report `engaged` separately from raw success.

## Integration

```ts
const research = loadAgentDir("agents/research");
const plan = loadAgentDir("agents/plan");
const impl = loadAgentDir("agents/implementation");
// Your host decides when each run starts:
await run(research, { deployment, workspace });
await run(plan, { deployment, workspace });
await run(impl, { deployment, workspace });
```

## Historical results

Mode-based `live-kit-v2` / `live-kit-all-v2` are archived under
`case-studies/coding-counterbalance/results/`. Those runs used advertise-then-deny
modes and suffered adapter no-ops on some models — not the v0.3 design.
