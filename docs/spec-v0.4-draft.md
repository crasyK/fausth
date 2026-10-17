# Harness Spec v0.4 (draft)

**Status:** Draft, 2026-10-16. Not normative yet. Replaces spec v0.3, which is retired and kept
only as a record of the journey. The decisions behind this draft are in
[`primitives-inventory.md`](primitives-inventory.md) §6–§8.
**Project name:** undecided. The draft uses the neutral `core_` prefix for built-ins and
`spec: harness/0.4-draft`.
**Design target:** someone can write a conforming engine in a weekend. If a section makes that
impossible, the section is wrong.

Keywords MUST / SHOULD / MAY as in RFC 2119. "Draft choice" marks a decision made while writing
this draft that has not been discussed yet.

---

## 0. Principles

1. **Interface, not behaviour.** The harness fixes what the model sees: the prompt, tool names,
   descriptions and schemas, events, and how hook decisions are rendered. Hosts implement tools
   however they like.
2. **The file wires; logic lives in tools.** The file has no expressions, loops or conditions.
   A condition is a hook that runs a tool.
3. **The log is the only state.** The engine keeps no state of its own. Rules read the log.
4. **What the model sees is a function of the harness and the log.** Every model request MUST be
   reconstructable from the resolved harness plus the log prefix, via §9. This is what makes
   runs replayable, and it is the training contract for harness-native models.
5. **Small and honest.** Code-executing tools are opaque (§3.4). Hooks see only top-level tool
   calls. The spec does not pretend to enforce what it can't.
6. **A child never gets more than its parent** (§10). This is the only security rule in the
   spec. Sandboxing, filesystem scopes and secrets belong to the deployment (§13).

---

## 1. Values

All values are JSON. Canonical form is **RFC 8785 (JSON Canonicalization Scheme)**: keys sorted
by UTF-16 code units, no whitespace, ECMAScript number formatting. JCS libraries exist for most
languages (e.g. `canonicalize` on npm). This replaces v0.3's integers-only rule, because
ordinary tool results contain decimal numbers. Comparing decimals with `eq` (§6) is the
author's responsibility.

Numbers are IEEE 754 doubles, as in RFC 8785: an engine reads every JSON number as a double, so
an integer beyond 2^53 is rounded the way ECMAScript rounds it (`18446744073709551615` →
`18446744073709552000`). Exact large integers travel as strings. (`rfc8785` on PyPI rejects such
integers instead, so it can't be used unchanged.) A value without a canonical form (a
non-finite number, a string with a lone surrogate) is an error.

`hash(x)` = lowercase hex SHA-256 of the UTF-8 bytes of the canonical form of `x`.

`excerpt(s, n)` = `s` if it has at most `n` code points, else its first `n` code points followed
by `…[truncated]`.

---

## 2. The harness file

YAML 1.2 (core schema; duplicate keys are an error) or JSON. Authoring tools MAY support
includes (e.g. a prompt in a separate file). What an engine runs is the **resolved harness**:
one JSON document with includes inlined. `harness_hash` = `hash(resolved harness)`.

Top-level fields (closed set; anything else is a validation error):

| Field | Required | Meaning |
|---|---|---|
| `spec` | yes | `harness/0.4-draft` |
| `name` | yes | Non-empty string. Not shown to the model. |
| `prompt` | yes | The system prompt text (§9.1). |
| `tools` | no | Model-facing tools (§3). The model is offered exactly these. |
| `handlers` | no | Hook-only tools (§3). Never offered to the model. |
| `hooks` | no | Ordered list (§5). |
| `limits` | no | §12. |

### Example: the chess harness from `cb-ability-v1` (arm S1G1p, with the stricter rule)

```yaml
spec: harness/0.4-draft
name: chess-legal-first
prompt: |
  You are playing chess. Find the best move for the side to move and play it.
tools:
  board_observe:
    description: "Read the current position: FEN, side to move, whether in check, position_hash."
    input: { type: object, properties: {}, additionalProperties: false }
  board_legal_moves:
    description: List every legal move for the side to move, in UCI and SAN.
    input: { type: object, properties: {}, additionalProperties: false }
  board_move:
    description: "Play one move in UCI notation (e.g. e2e4). Include reason: why this move."
    input:
      type: object
      required: [move, position_hash, reason]
      additionalProperties: false
      properties: { move: { type: string }, position_hash: { type: string }, reason: { type: string } }
hooks:
  - id: observe-first
    on: pre_tool
    match: board_move
    run: core_called_since
    with: { tool: board_observe }
  - id: legal-moves-first
    on: pre_tool
    match: board_move
    run: core_called_since
    with: { tool: board_legal_moves, since: board_move }
limits: { max_steps: 12, max_tool_calls: 12 }
```

---

## 3. Tools and handlers

### 3.1 Ids

Every id in `tools` and `handlers` MUST match `^[a-zA-Z0-9_-]{1,64}$` and be unique across both
maps. This is the intersection of what the major model APIs accept as a tool name, so no host
ever has to rename a tool (renaming would change the tokens). The prefix `core_` is reserved
for built-ins (§6, §10).

### 3.2 Declaration

```yaml
tools:
  <id>:
    description: <string>            # shown to the model
    input: <JSON Schema 2020-12>     # shown to the model; arguments are validated against it
    output: <JSON Schema 2020-12>    # optional; host results are validated against it
handlers:
  <id>:
    description: <string>            # optional; documentation only
    input: <JSON Schema>             # optional; validated hook input (§5.3)
```

JSON Schema uses standard semantics. The engine injects no defaults (write
`additionalProperties: false` to close a schema).

### 3.3 Invocation

The deployment binds every tool and handler id to an implementation (§13). The engine calls it
with the arguments and gets back either `{ok: true, result: <value>}` or
`{ok: false, error: <string>}`.
- `ok: false` is world feedback: the tool ran and failed. The model sees it (§9.3).
- An implementation that cannot be reached at all (binding missing, host crash) is an
  **infrastructure failure**: the run ends with `infra_failure` (§12). It is never shown to the
  model as if it were tool output.

A call is **successful** iff its arguments were valid, no hook denied it, and it returned
`ok: true`.

### 3.4 Code-executing tools are opaque

A tool may execute arbitrary code (`python_exec`, `call_proto_tool`, …). What happens inside is
the tool's business: the log records the call and its result, not the code's inner actions, and
hooks do not fire for them. An agent with an interpreter running at the host's privileges can go
around any host tool. A harness that needs its rules enforced should not offer a raw
interpreter.

---

## 4. Events

| Event | Fires | `match` | Decisions allowed (§5.4) |
|---|---|---|---|
| `session_start` | once, before the first request | — | `add_context` |
| `user_prompt` | for every user message (including the first) | — | `deny`, `add_context` |
| `pre_request` | before every model request | — | `replace_context`, `add_context` |
| `pre_tool` | before each tool call executes | tool ids | `deny`, `modify`, `add_context` |
| `post_tool` | after each tool call executed | tool ids | `replace`, `add_context` |
| `stop` | the model answered without tool calls | — | `continue`, `add_context` |
| `interrupt` | an interrupt is about to be delivered (§11) | sources | `deny`, `add_context` |

`allow` (no change) is valid for every event. There are no subagent events: spawning is the tool
`core_spawn` (§10), so `pre_tool` / `post_tool` with `match: core_spawn` cover it. There is no
compaction event: compaction is a `pre_request` hook (Appendix A.3).

---

## 5. Hooks

### 5.1 Declaration

```yaml
hooks:
  - id: <string>          # required, unique; shown to the model in the wrapper (§9.2)
    on: <event>
    match: <id> | [<id>, ...] | "*"   # tool events: tool ids; interrupt: sources; default "*"
    run: <handler id or core_* built-in>
    with: { ... }         # optional static arguments
    on_failure: end       # end (default) | skip; see §5.4
```

Hook ids match `^[a-zA-Z0-9_.-]{1,64}$`. `run` MUST name a declared handler or a built-in (§6).
A hook can't run a model-facing tool: a tool used by both the model and a hook is declared
twice under two ids.

### 5.2 Order

The hooks matching an event run **one after another, in declaration order**.
- The first `deny` (or `replace_context`, or `continue`) ends the chain for that event.
- `modify` chains: the next hook sees the modified arguments.
- `replace` (post_tool) chains: the next hook sees the replaced text, but `result` stays the
  original world result.
- `add_context` accumulates in order.

Handlers invoked by hooks never trigger hooks themselves.

### 5.3 Hook input

The handler receives one object:

```json
{
  "event": "pre_tool",
  "hook": "legal-moves-first",
  "with": {"tool": "board_legal_moves", "since": "board_move"},
  "call": {"tool": "board_move", "args": {"move": "e2e4", "position_hash": "...", "reason": "..."}},
  "result": {"ok": true, "result": {}},
  "message": "<text>",
  "interrupt": {"source": "timer", "text": "..."},
  "context": [ <messages> ],
  "view": [ <view entries> ]
}
```

Only the members that apply to the event are present: `call` for tool events, `result` for
`post_tool`, `message` for `user_prompt` and `stop`, `interrupt` for `interrupt`, `context`
(the rendered conversation, §9) for `pre_request`.

`view` is the filtered log, in order. It is **not** the raw log. Every entry carries the `step`
in which it happened:
- one entry per finished top-level tool call: `{step, tool, args, ok, result | error}`;
- one entry per delivered interrupt: `{step, interrupt: {source, text}}`.

The hook input also carries `step` (the current step) and, for `stop`, `continued` (how many
`continue` decisions this turn has had so far, §8). Tool calls from the current step were
made in the same model response as the call being checked: **the model had not seen their
results** when it made the call (see §6).

### 5.4 Hook output

```json
{"decision": "deny", "text": "<string>", "args": {}, "messages": []}
```

| `decision` | Members | Effect |
|---|---|---|
| `allow` | — | none |
| `add_context` | `text` | text is rendered for the model (§9.3) |
| `deny` | `text` | `pre_tool`: the call does not execute. `user_prompt`: the message is not admitted (the host shows `text` to the user). `interrupt`: the interrupt is dropped. |
| `modify` | `args`, optional `text` | the call executes with `args` (validated against the tool's input schema again) |
| `replace` | `text` | the model sees `text` instead of the result |
| `continue` | `text` | the model is asked to keep going |
| `replace_context` | `text` | the conversation after the system prompt is replaced by `text` |

A decision not allowed for the event, missing members, or an invalid `modify` → the hook
**failed**. The same holds when the handler is unreachable or returns `ok: false`. (Retrying is
the host's job inside the binding, before it reports a failure.)
- `on_failure: end` (default): the run ends with `infra_failure`. A rule that can't be checked
  must not silently pass, and an infrastructure problem must not show up in the model's tokens.
- `on_failure: skip`: the hook is treated as `allow` and a `hook` log entry with
  `decision: "failed"` is written; the model sees nothing. Meant for advisory hooks (tips,
  context), never for rules.

`text` is excerpted to `limits.max_hook_text` code points (default 4000).

---

## 6. Built-in handlers

Every engine implements these identically. They read only `view`, `step` and `with`.

**Seen results only.** Built-ins consider only `view` entries with `step` < the current step,
i.e. results the model had already seen when it made the call. Example: a model that sends
`board_legal_moves` and `board_move` in the same response fails `core_called_since` for the
move, because it chose the move before seeing the legal moves. Parallel calls stay allowed;
they just don't count as proof of use.

| Built-in | `with` | Check passes iff | Failure text |
|---|---|---|---|
| `core_called_since` | `tool`, optional `since` | a successful call of `tool` exists after the last successful call of `since` (or anywhere, without `since`) | `{tool} not called since the last {since}` / `{tool} not called yet` |
| `core_last_result` | `tool`, `path`, `eq` | the last successful call of `tool` has `eq` at `path` (a `.`-separated path into its result) | `last {tool} result {path} is not {eq}` / `{tool} has no successful call yet` |
| `core_count` | `tool`, `max` | fewer than `max` successful calls of `tool` exist | `{tool} limit reached ({max})` |
| `core_deny` | `text` | never | `{text}` |
| `core_context` | `text` | always; returns `add_context` with `text` | — |

**A failed check becomes the event's push-back decision:**

| Event | Failed check becomes |
|---|---|
| `pre_tool`, `user_prompt`, `interrupt` | `deny` |
| `stop` | `continue` |
| `post_tool` | `add_context` (the result stays; the note is appended) |
| `pre_request`, `session_start` | not allowed (validation error), except `core_context` |

A passed check is `allow`. `{eq}` renders as its canonical JSON. `core_last_result` replaces v0.3
checkpoints: "the user approved" is the last result of the tool bound to the user.

New built-ins are added only when a real harness needs one.

---

## 7. The log

JSON Lines, one canonical object per line, `seq` from 1. Entry types:

| `type` | Members |
|---|---|
| `run_start` | `harness_hash`, `depth` |
| `system` | `text` (the assembled system prompt, §9.1) |
| `user` | `text` |
| `assistant` | `step`, `text`, `tool_calls: [{call_id, tool, args}]`, `reasoning?`, `reasoning_opaque?` |
| `hook` | `hook`, `event`, `decision`, `text?`, `args?`, `call_id?` |
| `tool_result` | `call_id`, `tool`, `ok`, `result` or `error` |
| `interrupt` | `source`, `text`, `step` |
| `harness_changed` | `harness_hash` (§12.3) |
| `run_end` | `reason`: `stop` \| `limit` \| `infra_failure` \| `host_end` |

**Reasoning** (the model's thinking tokens) is always logged when the provider returns it:
plain text as `reasoning`, an encrypted or signed blob as `reasoning_opaque: {provider, data}`.
The log is the training data, and reasoning is its most valuable part.

`call_id` is `c<seq of the assistant entry>-<index>`. It is assigned by the engine, not by the
provider, so logs stay identical across providers.

Entries of a child run (§10) are written inline with `depth` = parent depth + 1 and
`parent_call` = the `call_id` of the `core_spawn` call.

---

## 8. The run loop

1. Log `run_start`. Run `session_start` hooks. Assemble and log `system` (§9.1).
2. Wait for a user message. Run `user_prompt` hooks. If denied, go back to 2. Else log `user`.
3. **Step.** If `steps_used = max_steps`, end with `limit`.
   1. Deliver queued interrupts (§11).
   2. Run `pre_request` hooks.
   3. Render the request (§9) and call the model. `steps_used += 1`. Log `assistant`.
   4. For each tool call, **in order**:
      - If `tool_calls_used = max_tool_calls`, end with `limit`.
      - `tool_calls_used += 1`.
      - Unknown tool or invalid arguments → `tool_result` with `ok: false`, `error:
        "invalid arguments: <schema error>"` (no hooks run).
      - Run `pre_tool` hooks. If denied → no execution; the deny is the result (§9.3).
      - Execute. Log `tool_result`. Run `post_tool` hooks.
   5. If there were tool calls → next step.
   6. No tool calls → if this turn has had fewer than `limits.max_continues` `continue`
      decisions, run `stop` hooks; otherwise skip them (the model may stop). If `continue` →
      next step. Otherwise the turn ends: go to 2 (interactive host) or end with `stop`
      (one-shot host). The `continue` count resets when a new user message is admitted.

A deny never ends the run. Only limits, infrastructure failures, the host, or the end of the
conversation do.

---

## 9. Rendering: what the model sees

The engine produces a provider-neutral request: `system` (string), `tools` (list), `messages`
(list of `user` / `assistant` / `tool` messages). Host adapters map it to a provider API without
changing any text. Reasoning is **not** part of the neutral request. Whether logged reasoning is
sent back to the model (some providers require it within a tool loop) is decided by the provider
adapter, following that provider's rules. Other provider extras (caching) are out of scope.

### 9.1 System prompt

`prompt`, then for each `session_start` `add_context` in hook order: `"\n\n"` + wrapper (§9.2).
Nothing else: no host-authored text.

### 9.2 The wrapper

Every hook decision the model sees is rendered as:

```text
<hook event="{event}" id="{hook id}" decision="{decision}">{text}</hook>
```

Inside `{text}` the only escape is `</hook>` → `&lt;/hook>`. Attribute values never need
escaping (ids and names are restricted).

Interrupts use their own wrapper: `<interrupt source="{source}">{text}</interrupt>`, with the
same escape for `</interrupt>`.

### 9.3 Placement

| Situation | What the model sees |
|---|---|
| tool result, `ok: true` | the result: a string as-is, anything else as canonical JSON |
| tool result, `ok: false` | `{"error":"<error>"}` |
| `pre_tool` `deny` | the tool message for that call is the wrapper alone |
| `pre_tool` `modify` | the tool message is the wrapper (`text` or `args changed`), `"\n"`, then the result |
| `post_tool` `replace` | the tool message is the wrapper alone |
| `add_context` on a tool event | appended to that call's tool message: `"\n\n"` + wrapper |
| `add_context` on `user_prompt` | appended to the user's text: `"\n\n"` + wrapper |
| `add_context` on `pre_request`, `stop`, `interrupt`; `stop` `continue` | a user-role message with the wrapper |
| delivered interrupt | a user-role message with the interrupt wrapper |
| `replace_context` | all messages after the system prompt are replaced by one user-role message with the wrapper |

Several user-role contributions in a row are **merged** into one user message, joined by
`"\n\n"`, in log order. The engine never emits system messages mid-conversation.

---

## 10. Subagents: `core_spawn`

`core_spawn` is a built-in **model-facing** tool. A harness offers it by listing it in `tools`
(its `description` may be overridden; its input schema is fixed):

```json
{"harness": {<a resolved harness>}, "task": "<string>"}
```

The parent writes the child's whole harness: prompt, tools, handlers, hooks. That is a far
richer handoff than a prompt.

**Narrowing check**, before the child starts. The first failure is a deny with a fixed template
(hook id `core_spawn`):
1. The child's `tools` ⊆ the parent's `tools` by id, with identical `input` schemas.
   Descriptions may differ.
2. The child's `handlers` ⊆ the parent's `handlers` by id.
3. Child limits ≤ the parent's remaining limits.
4. The child may list `core_spawn` only if `depth + 1 < limits.max_depth` of the parent
   (default `max_depth: 1`: children can't spawn).

**Inherited hooks.** The parent's hooks run **before** the child's own hooks, on every matching
child event. A parent can't drop its own rules by writing a child without them.

The child runs synchronously with the parent's deployment bindings. Its steps and tool calls
count against the parent's limits. Its log is written inline (§7). The `core_spawn` result is
`{"text": <the child's final assistant text>, "steps": n, "tool_calls": n}`.

Background work (an asynchronous child, a long job) is a host tool that returns immediately and
later delivers an interrupt with `source: "subagent"` or `"job"`.

---

## 11. Interrupts

The host may push `{source, text}` at any time. `source` is a free string; conventional values
are `user`, `timer`, `subagent`, `job`, `world`. Interrupts are queued and delivered **only at
step boundaries** (§8 step 3.1), in arrival order. Each passes the `interrupt` hooks
(`match` = sources); if not denied, it is logged with the current `step` and rendered (§9.3).

In replay, interrupts come from a recorded file with the step at which each arrived.

---

## 12. Limits, run end, reload

### 12.1 Limits

`limits`: `max_steps` (model requests, default 1000), `max_tool_calls` (default 1000),
`max_depth` (default 1), `max_continues` (default 3; `stop` hooks per turn, §8),
`max_hook_text` (default 4000), `timeout_ms` (host wall clock; never
part of replay).

### 12.2 Run end

`run_end.reason`: `stop`, `limit`, `infra_failure`, `host_end`. Infrastructure failures (model
API errors, unreachable tools or handlers, failed hooks) are never scored as model behaviour.

### 12.3 Live reload

A host MAY replace the harness during a run (for example after the agent edited its own file).
The new harness takes effect at the next step boundary. The engine logs `harness_changed` with
the new hash, re-assembles the system prompt (logged as a new `system` entry) and offers the new
tool set from then on. Whether and how a harness edits itself is not part of this spec.

---

## 13. Deployment (host side)

The deployment file is **not** part of the harness and never changes what the model sees. It
holds:
- **Bindings:** for every tool and handler id, an implementation: `script`, `http`, `mcp`,
  `model` (a prompt plus model id), `human`, or `recorded`. A `human` binding MUST be answered
  by a human or a declared simulator, never from the acting model's own arguments.
- **The model transport.**
- **Sandbox, filesystem scopes, secrets, protected paths:** enforced by the host's tool
  implementations.

A deployment that leaves a declared id unbound is rejected before the run starts.

---

## 14. Conformance

A fixture directory contains:
- `harness.json` (resolved)
- `model.jsonl`: recorded assistant responses
- `tools.jsonl`: recorded results for tools **and** handlers, by call order
- optional `user.jsonl` and `interrupts.jsonl` (with `step`)
- `expected.log.jsonl`: the log
- `expected.requests.jsonl`: every rendered model request (§9)

Built-ins are computed, never recorded. Two engines conform iff both expected files are
byte-identical. `expected.requests.jsonl` is new compared with v0.3: **it tests the interface
itself**, i.e. exactly what a fine-tuned model would see.

---

## Appendix A: Recipes (non-normative)

**A.1 Skills.** A tool `skill_read {name}` returns a `SKILL.md`. A `session_start` hook runs a
handler that lists skill names and descriptions → `add_context`.

**A.2 Memory with a reason check.** Tools `memory_save {key, text, reason}` and `memory_recall
{key}`, implemented by the host (JSON, sqlite, markdown). A `pre_tool` hook on `memory_save`
runs a handler `judge_reason` (bound to a model) that denies weak reasons.

**A.3 Compaction.** A `pre_request` hook runs a handler that counts the tokens in `context`;
above a threshold it asks a model for a summary and returns `replace_context`.

**A.4 Completion gate.** A `stop` hook runs `core_last_result {tool: tests_run, path: exit_code,
eq: 0}`. If the tests didn't pass, the failed check becomes `continue` (§6). If the model can't
fix them, `limits.max_continues` (default 3) lets it stop after three rounds instead of looping
until `max_steps`.

**A.5 Self-refinement.** Flexible tools such as `call_proto_tool {name, args}` and
`write_tool {name, code}`, plus a harness file the host re-reads (§12.3).

**A.6 Code-only agent (Prime Agent style).** `tools: {python_exec: …}` and nothing else.

---

## Appendix B: Open points

**Resolved 2026-10-16:** built-ins count only results the model had seen (§6); one mapping
from a failed check to each event's push-back decision (§6); `on_failure: end | skip` (§5.4);
reasoning is always logged and passed back by adapters per provider (§7, §9); RFC 8785 (§1);
`limits.max_continues` ends stop loops (§8, §12).

*Check of the cb-ability-v1 data for the parallel-call problem:* 0 of ~8,700 model responses in
the four main runs contained more than one tool call (`parallel_tool_calls=false` was frozen in
the protocol, and the runner executed only the first call). The S1G1p gate results are not
affected.

**Still open:**
1. **Exact wording** of the built-in failure texts and the `core_spawn` narrowing denies.
2. **Images and other non-text results:** planned for v0.4.1, after the first host runs.
   Needs a fixed adapter rule for providers that don't accept images in tool results.

**Next: the first hosts.** A single HTML page running the TS engine (the chess harness with
`chess.js`, a direct model API call, the key pasted in by the user, fixtures replayable in the
page), and the Python CLI running the same file with `python-chess`. First check: which model
endpoint allows calls from a browser (KIT gateway unknown; Anthropic has a direct-browser-access
header; OpenRouter-style endpoints usually allow it).
