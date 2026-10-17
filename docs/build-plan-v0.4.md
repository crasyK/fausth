# Build plan: spec v0.4

**Status:** Plan of record, 2026-10-16. The design discussion is closed; this is what the build
session executes.

**Read first, in this order:**
1. [`spec-v0.4-draft.md`](spec-v0.4-draft.md): what to build. This is the source of truth.
2. [`primitives-inventory.md`](primitives-inventory.md) §6–§8: why. Read it only when a spec
   sentence seems odd.

## Ground rules

- **Spec first.** Every fixture must be derivable from the spec text. If it isn't, fix the spec
  before the code, and say so.
- **Interface, not behaviour.** The engines guarantee what the model sees, not what the tools do.
- **Parity is top severity.** TS and Python must produce byte-identical `expected.log.jsonl`
  **and** `expected.requests.jsonl` for every fixture.
- **Spartan.** No Counterbalance vocabulary in the spec, engines or fixtures. No feature that
  isn't in the spec. Weekend-engine target: if an engine module grows hard to read, the spec is
  too big; flag it instead of writing more code.
- **Usage budget.** No large subagent fan-outs.
- **v0.3 is retired.** No compatibility layer. The old code stays reachable through the
  `v0.4.0-alpha` tag.

## Steps

| # | Step | Done when |
|---|---|---|
| 0 | **Housekeeping.** New branch. Move the v0.1–v0.3 specs, the v0.3 draft and the Counterbalance-specific docs to `docs/archive/`. Remove the v0.3 fixtures and the v0.3 engine paths that won't be reused. | Main docs point only to v0.4; CI is temporarily reduced to what exists. |
| 1 | **Values.** RFC 8785 canonicalization and `hash()` in TS and Py, with shared test vectors (decimals, unicode keys, `-0`, large integers). | Both engines pass the same vector file. |
| 2 | **Loader and validator** (§2–§3, §5.1). JSON Schema `schema/harness.v0.4.json`. Tool id regex, closed fields, hook references, `core_` reserved prefix. | Valid and invalid example harnesses are accepted and rejected identically. |
| 3 | **Log and view** (§7, §5.3). Log entries, `call_id`, `step`, `view` with seen-results semantics. | Unit tests per entry type. |
| 4 | **Run loop with a replay host** (§8). Recorded `model.jsonl`, `tools.jsonl`, `user.jsonl`, `interrupts.jsonl`. Limits including `max_continues`. | A tools-only fixture replays byte-identically in both engines. |
| 5 | **Hooks** (§5, §6). Chain order, every decision kind, the push-back mapping, `on_failure`, the five built-ins with their exact failure texts. | One fixture per decision kind and per built-in. |
| 6 | **Rendering** (§9). The provider-neutral request, the wrapper and its escape, the placement table, merging of user-role contributions. | `expected.requests.jsonl` for every fixture so far. |
| 7 | **`core_spawn`** (§10). Narrowing check, inherited parent hooks, nested log, charging against the parent's limits. | Fixtures: an allowed spawn, each narrowing denial, a parent hook firing inside the child. |
| 8 | **Interrupts and live reload** (§11, §12.3). | One fixture each. |
| 9 | **The chess fixture.** The spec's §2 example harness with recorded model responses, including a response that sends `board_legal_moves` and `board_move` together (it must fail the seen-results check). | Parity green on the full fixture set. |
| 10 | **Provider adapter.** OpenAI-compatible (the KIT gateway): neutral request → API → log, including `reasoning` / `reasoning_opaque`. | A live smoke run against one model. |
| 11 | **Host 1: Python CLI.** `run <harness> --deployment <file>`, with bindings for `script`, `recorded` and `model`, and `python-chess` tools. | The chess harness plays a move live. |
| 12 | **Host 2: a single HTML page.** TS engine, `chess.js` tools, the API key pasted in, fixtures replayable in the page. **First check which model endpoint allows browser calls** (KIT gateway unknown). | The same harness file plays in the browser, and the page's fixture replay matches the Python output. |

Steps 1–9 are pure engine work with no network. Steps 10–12 need a model endpoint.

## Not in this build

Images (v0.4.1). Compaction, skills, memory and self-refinement exist only as recipes
(Appendix A), with no built-ins. Interop with Claude Code / Codex / dsh. The project's rename.

## Still open (decide while building, not before)

- The exact wording of the built-in failure texts and the `core_spawn` denials (spec Appendix B).
  Decide them in step 5 / step 7 and write them into the spec.
- **Version numbering:** the `v0.4.0-alpha` release already exists and implements spec v0.3.
  Recommendation: the release that implements this spec is **0.5.0**, and the spec file is
  renamed to `spec-v0.5.md` when it becomes normative, so spec and release numbers match.
