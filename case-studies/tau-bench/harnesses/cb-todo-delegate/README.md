# cb-todo-delegate — RETIRED

Status: **retired, results invalid** (audit 2026-10-12, findings CASE-2/3/7/8; see
[`../../../CLAIMS-STATUS.md`](../../../CLAIMS-STATUS.md)).

Why:

- the runner seeded `tau/todos.json` with one `mutate_N_<tool>` slot per **gold** mutating
  action and one report slot per **gold** required output, and the engine blocked any mutation
  not named by a slot — the harness was steered by the answer key;
- the agent's prompt contained the hidden customer instruction verbatim, and the "user"
  always answered "yes";
- the world lacked `modify_pending_order_payment` and accepted hollow exchanges.

What re-establishing a todo-delegate result would need: an intake phase that derives its own
todo list from the conversation with the simulated user (no gold-derived structure), generic
(non-τ) engine mechanisms for todos, the faithful world (`../../world/tau.mjs`), and evaluation
on the held-out `eval` split only.

The YAMLs stay loadable (engine tests use `agents/worker` as a fixture) and validate; they are
not listed in any manifest.
