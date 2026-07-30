# Coding Counterbalance case study pack

Implements the evaluation protocol in
[`docs/case-studies/PROTOCOL.md`](../../docs/case-studies/PROTOCOL.md).

| Path | Role |
|------|------|
| [`manifest.yml`](manifest.yml) | Matrix pins (tasks, deployments, reps) |
| [`tasks/`](tasks/) | Eight fixed coding tasks + seeds |
| [`harnesses/permissive-control/`](harnesses/permissive-control/) | Matched ablation harness |
| [`deployments/`](deployments/) | Local OpenRouter / KIT / recorded |
| [`recorded/`](recorded/) | Deterministic model traces per task×condition |
| [`expected/scoring.yml`](expected/scoring.yml) | Scorer rule ids |
| [`results/`](results/) | Checked-in summary + live smoke |

```bash +code
node --test scripts/case-study-score.test.mjs
node scripts/case-study-coding.mjs --mode recorded
node scripts/case-study-coding.mjs --mode live --limit 4
```
