# Harness Spec v0.5

**Status:** Normative, 2026-10-17. Release 0.5.0 implements it: the TypeScript and Python engines
in this repository produce byte-identical logs and requests for every fixture in
`conformance/`. Replaces spec v0.3, which is retired and kept only as a record of the journey
(drafted as v0.4; the version follows the release). The decisions behind it are in
[`primitives-inventory.md`](primitives-inventory.md) §6–§8.
**Project name:** undecided. Built-ins use the neutral `core_` prefix; harness files declare
`spec: harness/0.5`.
**Design target:** someone can write a conforming engine in a weekend. If a section makes that
impossible, the section is wrong.

Keywords MUST / SHOULD / MAY as in RFC 2119.

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

YAML 1.2 (core schema; duplicate keys are an error) or JSON, which is read as YAML 1.2 (so
duplicate keys are an error there too). The document MUST denote a JSON value: string keys
only, finite numbers only, no tags outside the core schema. Authoring tools MAY support
includes (e.g. a prompt in a separate file). What an engine runs is the **resolved harness**:
one JSON document with includes inlined. `harness_hash` = `hash(resolved harness)`.
[`schema/harness.v0.5.json`](../schema/harness.v0.5.json) is the JSON Schema of the file; the
cross-references (§3.1, §5.1, §6) are checked in addition.

Top-level fields (closed set; anything else is a validation error):

| Field | Required | Meaning |
|---|---|---|
| `spec` | yes | `harness/0.5` |
| `name` | yes | Non-empty string. Not shown to the model. |
| `prompt` | yes | The system prompt text (§9.1). |
| `tools` | no | Model-facing tools (§3). The model is offered exactly these. |
| `handlers` | no | Hook-only tools (§3). Never offered to the model. |
| `hooks` | no | Ordered list (§5). |
| `limits` | no | §12. |

### Example: the chess harness from `cb-ability-v1` (arm S1G1p, with the stricter rule)

```yaml
spec: harness/0.5
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
for built-ins (§6, §10): `core_spawn` is the only one that may appear in `tools`, and no
`handlers` id may use the prefix.

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

Both maps are closed: no other members. Schemas are JSON objects. An engine compiles every schema
when it loads the harness; a schema that doesn't compile (invalid against the 2020-12
meta-schema, an unresolvable `$ref`, a `pattern` that isn't a valid regular expression) makes
the harness invalid. Regular expressions are ECMA-262 with the `u` flag, as JSON Schema
recommends: in other languages an engine translates them (`$` is the end of input, `.` excludes
line terminators, `\d` `\w` `\b` are ASCII, `\s` is ECMAScript's whitespace).

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
- So is an answer that breaks the interface: not of the two forms above, a `result` that isn't
  JSON (§1), or a `result` that fails the tool's `output` schema.

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
| `session_start` | once per run, before its first request, and again after a reload (§12.3) | — | `add_context` |
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

`match` is only valid on `pre_tool` and `post_tool`, where every id MUST be a declared tool,
and on `interrupt`, where the ids are sources (§11). A list is non-empty and doesn't contain
`"*"`. A built-in's `with` holds exactly the members listed in §6, and its `tool` and `since`
MUST be declared tools.

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
(the rendered conversation, §9) for `pre_request`. `event`, `hook`, `with` (`{}` when the hook
has none), `step` and `view` are always present. `call.args` are the arguments as the chain has
modified them so far (`post_tool`: the arguments the call ran with); `message` is the user's
text (`user_prompt`) or the response's `text` (`stop`); `context` is the `messages` of the
request as it would be rendered at that point, so it includes the chain's earlier
`add_context`. On `post_tool`, after a `replace` earlier in the chain, `replaced` holds the
text that replaces the result so far.

If the handler declares an `input` schema, the engine validates this object against it before
calling the binding; if it doesn't match, the hook failed (§5.4) and the binding is not called.

`view` is the filtered log, in order. It is **not** the raw log. Every entry carries the `step`
in which it happened:
- one entry per finished top-level tool call: `{step, tool, args, ok, result | error}`;
- one entry per delivered interrupt: `{step, interrupt: {source, text}}`.

A call is finished when its `tool_result` is logged, or when a `pre_tool` hook denied it (the
deny is its result, §8): then `ok` is `false` and `error` is the deny's `text`. `args` are the
arguments the call ran with, i.e. after any `modify`. The entries are in the order in which the
calls finished. A run's view holds only its own entries: a child run's calls are not in its
parent's view, and the parent's calls are not in the child's (§10).

The hook input also carries `step` (the current step) and, for `stop`, `continued` (how many
`continue` decisions this turn has had so far, §8). Tool calls from the current step were
made in the same model response as the call being checked: **the model had not seen their
results** when it made the call (see §6).

### 5.4 Hook output

```json
{"decision": "modify", "args": {}, "text": "<string>"}
```

The handler's `result` is this object. It holds exactly the members its decision lists below
(`text` is a string, `args` any JSON value); anything else makes the hook fail.

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
**failed**. The same holds when the handler is unreachable, returns `ok: false`, answers in
neither form of §3.3, or its hook input fails its `input` schema (§5.3). (Retrying is the
host's job inside the binding, before it reports a failure.) A failed hook writes a `hook` entry
with `decision: "failed"` and no `text`; then:
- `on_failure: end` (default): the run ends with `infra_failure`. A rule that can't be checked
  must not silently pass, and an infrastructure problem must not show up in the model's tokens.
- `on_failure: skip`: the hook is treated as `allow`; the model sees nothing. Meant for
  advisory hooks (tips, context), never for rules.

`text` is excerpted to `limits.max_hook_text` code points (default 4000) before it is logged.

---

## 6. Built-in handlers

Every engine implements these identically. They read only `view`, `step` and `with`.

**Seen results only, for passing.** What makes a check pass must be a result the model had
already seen when it made the call: a `view` entry with `step` < the current step. Example: a
model that sends `board_legal_moves` and `board_move` in the same response fails
`core_called_since` for the move, because it chose the move before seeing the legal moves.
Parallel calls stay allowed; they just don't count as proof of use. What counts against a call
counts as soon as it has finished, same response included: the `since` call that resets
`core_called_since`, and the calls `core_count` counts. So `[board_move, board_move]` in one
response fails the second move, and two calls in one response can't get past `max: 1`.

| Built-in | `with` | Check passes iff | Failure text |
|---|---|---|---|
| `core_called_since` | `tool`, optional `since` | a seen successful call of `tool` exists after the last successful call of `since` (or anywhere, without `since` or when `since` has no successful call) | `{tool} not called since the last {since}` / `{tool} not called yet` |
| `core_last_result` | `tool`, `path`, `eq` | the last seen successful call of `tool` has `eq` at `path` | `last {tool} result {path} is not {eq}` / `{tool} has no successful call yet` |
| `core_count` | `tool`, `max` | fewer than `max` successful calls of `tool` exist | `{tool} limit reached ({max})` |
| `core_deny` | `text` | never | `{text}` |
| `core_context` | `text` | always; returns `add_context` with `text` | — |

`tool`, `since`, `path` and `text` are strings, `max` is a non-negative integer, `eq` is any JSON
value. "Successful" is `ok: true` in the view. `core_called_since` uses its first failure text
when `since` has a successful call, else the second. `path` is a `.`-separated list of object
member names and array indexes (`0`, `1`, …, no leading zeros); `""` is the result itself; a
path that leads nowhere fails the check, and `eq` is compared by canonical form.
`{tool}`, `{since}` and `{path}` render as given, `{max}` and `{eq}` as canonical JSON.

**A failed check becomes the event's push-back decision:**

| Event | Failed check becomes |
|---|---|
| `pre_tool`, `user_prompt`, `interrupt` | `deny` |
| `stop` | `continue` |
| `post_tool` | `add_context` (the result stays; the note is appended) |
| `pre_request`, `session_start` | not allowed (validation error), except `core_context` |

A passed check is `allow`. `core_last_result` replaces v0.3 checkpoints: "the user approved" is
the last result of the tool bound to the user.

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
plain text as `reasoning`, an encrypted or signed blob as `reasoning_opaque: {provider, data}`
(`provider` a string, `data` any JSON value). The log is the training data, and reasoning is its
most valuable part. A response that breaks this shape (§14 gives it) is an infrastructure
failure.

`call_id` is `c<seq of the assistant entry>-<index>`, with `index` counting the response's tool
calls from 0. It is assigned by the engine, not by the provider, so logs stay identical across
providers.

Entries of a child run (§10) are written inline with `depth` = parent depth + 1 and
`parent_call` = the `call_id` of the `core_spawn` call. Top-level entries carry neither member,
except `run_start`, which always carries `depth`.

Member details: `assistant.text` is `""` when the response has no text, and `tool_calls` is
`[]` when it has no calls. A `hook` entry is written for **every** hook that runs, `allow`
included, in chain order (§5.2); it carries `call_id` on tool events, `text` when its decision
has one, and `args` for `modify`. A `tool_result` carries `result` iff `ok`, else `error`. An
optional member is left out, never `null`. Every line ends with `\n`.

---

## 8. The run loop

1. Log `run_start`. Run `session_start` hooks. Assemble and log `system` (§9.1).
2. Ask the host for the next user message; if the conversation has none left, end with `stop`.
   A message that isn't a string is an infrastructure failure. Run `user_prompt` hooks. If
   denied, go back to 2. Else log `user`.
3. **Step.** If `steps_used ≥ max_steps`, end with `limit`.
   1. Top-level run only: take a replacement harness (§12.3), then deliver queued interrupts
      (§11).
   2. Run `pre_request` hooks.
   3. Render the request (§9) and call the model. `steps_used += 1`. Log `assistant`.
   4. For each tool call, **in order**:
      - If `tool_calls_used ≥ max_tool_calls`, end with `limit`.
      - `tool_calls_used += 1`.
      - Unknown tool → `tool_result` with `ok: false`, `error: "invalid arguments: unknown
        tool"`; arguments that fail the input schema → `error: "invalid arguments: does not
        match the input schema"`. No hooks run. (The texts are fixed so that every engine and
        every schema library produces the same tokens.)
      - Run `pre_tool` hooks. If denied → no execution; the deny is the result (§9.3).
      - Execute. Log `tool_result`. Run `post_tool` hooks.
   5. If there were tool calls → next step.
   6. No tool calls → if this turn has had fewer than `limits.max_continues` `continue`
      decisions, run `stop` hooks; otherwise skip them (the model may stop). If `continue` →
      next step. Otherwise the turn ends: go to 2. The `continue` count resets when a new user
      message is admitted.

A deny never ends the run. Only limits, infrastructure failures, the host, or the end of the
conversation do. A one-shot host is a conversation with one user message. The host may end the
run whenever it is asked for something (a user message, a model response, a binding's answer):
the run ends with `host_end` (§12.2).

**The current step** is the number of model requests made so far, counting every run in the log
(child runs included, §10): `0` before the first request, `n` for everything that follows the
`n`-th request up to the next one (its tool calls, `stop`, interrupts delivered before request
`n + 1`). The `step` members of the log and the hook input hold this number, so `step` `n` is
line `n` of `expected.requests.jsonl`. `steps_used` and `tool_calls_used` count a run's own
requests and calls and those of its children.

---

## 9. Rendering: what the model sees

The engine produces a provider-neutral request: `system` (string), `tools` (list), `messages`
(list of `user` / `assistant` / `tool` messages). Host adapters map it to a provider API without
changing any text. Its exact shape, which `expected.requests.jsonl` records (§14):

```json
{"system": "<text>",
 "tools": [{"name": "<id>", "description": "<text>", "input": {}}],
 "messages": [{"role": "user", "text": "<text>"},
              {"role": "assistant", "text": "<text>", "tool_calls": [{"call_id": "c4-0", "tool": "<id>", "args": {}}]},
              {"role": "tool", "call_id": "c4-0", "tool": "<id>", "text": "<text>"}]}
```

`tools` holds every entry of the harness's `tools` in sorted id order (the order of canonical
JSON, §1: `harness_hash` doesn't see declaration order, so the request mustn't either); `output`
schemas are not shown. An assistant message repeats its log entry's `text` and `tool_calls`.

Reasoning is **not** part of the neutral request. Whether logged reasoning is sent back to the
model (some providers require it within a tool loop) is decided by the provider adapter,
following that provider's rules. Other provider extras (caching) are out of scope.

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
| `add_context` on `interrupt` | appended to the interrupt's message: `"\n\n"` + wrapper |
| `add_context` on `pre_request`, `stop`; `stop` `continue` | a user-role message with the wrapper |
| delivered interrupt | a user-role message with the interrupt wrapper |
| `replace_context` | all messages after the system prompt are replaced by one user-role message with the wrapper |
| `allow`, `failed`, a `deny` on `user_prompt` or `interrupt` | nothing |

When several decisions concern one call, its tool message is built from its log entries in log
order: each `modify` adds its wrapper and `"\n"`; then comes the body, which is the `deny`
wrapper if a hook denied the call, else the wrapper of the last `replace`, else the result; then
each `add_context` adds `"\n\n"` + wrapper. The tool messages follow their assistant message in
call order; a call that never finished (the run ended first) has none. The `add_context`
decisions of a denied user message or interrupt are dropped with it.

Several user-role contributions in a row are **merged** into one user message, joined by
`"\n\n"`, in log order; the user's own messages count as contributions. The engine never emits
system messages mid-conversation.

---

## 10. Subagents: `core_spawn`

`core_spawn` is a built-in **model-facing** tool. A harness offers it by listing it in `tools`
(its declaration may hold only `description`, which overrides the default; its input schema is
fixed). Its default description and its input schema, as the model sees them:

```text
Run a child agent on a subtask. harness: the child's complete harness; it may use only tools and handlers you have. task: its first user message. Returns the child's final text.
```

```json
{"type": "object", "required": ["harness", "task"], "additionalProperties": false,
 "properties": {"harness": {"type": "object"}, "task": {"type": "string"}}}
```

The parent writes the child's whole harness: prompt, tools, handlers, hooks. That is a far
richer handoff than a prompt.

**Narrowing check**, when the call executes (after its `pre_tool` hooks). The first failure is a
deny (hook id `core_spawn`, event `pre_tool`) with this text:

| # | Check | Deny text |
|---|---|---|
| 0 | the child harness is valid (§2, §3, §5.1) | `child harness is not valid` |
| 1 | the child's `tools` ⊆ the parent's `tools` by id, with identical `input` schemas (canonical form); descriptions may differ | `child tool {id} is not a parent tool` / `child tool {id} has a different input schema` |
| 2 | the child's `handlers` ⊆ the parent's `handlers` by id | `child handler {id} is not a parent handler` |
| 3 | child limits ≤ the parent's | `child limit {name} exceeds the parent's {value}` |
| 4 | the child lists `core_spawn` only if `depth + 1 < max_depth` of the parent (default `max_depth: 1`: children can't spawn) | `child at depth {depth + 1} may not spawn` |

Ids are checked in sorted order, limits in the order of §12.1. For check 3, `max_steps` and
`max_tool_calls` are compared with what the parent has left (its limit minus what it has used,
this call included); `max_depth`, `max_continues` and `max_hook_text` with the parent's own
value; `timeout_ms` is the host's. A limit the child leaves out is the parent's value, or what
the parent has left. `{value}` renders as canonical JSON.

**The child run** is a run (§8) whose only user message is `task`, at `depth` = parent depth + 1,
logged inline (§7). Its view holds only its own calls (§5.3); the current step counts every
request in the log, the child's included (§8).

**Inherited hooks.** The parent's hooks, including those it inherited itself, run **before** the
child's own hooks, on every matching child event. A parent can't drop its own rules by writing a
child without them. An inherited hook keeps its harness: its handler and the handler's `input`
schema are the declaring harness's.

The child runs synchronously with the parent's deployment bindings. Each of its model requests
and tool calls counts against the child and every run above it. The `core_spawn` result is
`{"text": <the text of the child's last assistant entry, "" if none>, "steps": n, "tool_calls":
n}`, with the requests and calls counted against the child. A child that ends with `stop` or
`limit` returns this result; a child that ends with `infra_failure` or `host_end` ends the whole
run the same way.

Background work (an asynchronous child, a long job) is a host tool that returns immediately and
later delivers an interrupt with `source: "subagent"` or `"job"`.

---

## 11. Interrupts

The host may push `{source, text}` at any time. `source` matches the id pattern of §3.1 (it
appears unescaped in the wrapper, §9.2); conventional values are `user`, `timer`, `subagent`,
`job`, `world`. Interrupts are queued and delivered **only at
step boundaries** (§8 step 3.1) of the top-level run, in arrival order: they are meant for the
agent the host talks to, so while a child runs they wait. Each passes the `interrupt` hooks
(`match` = sources); if not denied, it is logged with the current `step` and rendered (§9.3).
Interrupts still queued when the run ends are dropped. An interrupt whose `source` or `text`
isn't valid is an infrastructure failure.

In replay, interrupts come from a recorded file with the step at which each arrived.

---

## 12. Limits, run end, reload

### 12.1 Limits

`limits`: `max_steps` (model requests, default 1000), `max_tool_calls` (default 1000),
`max_depth` (default 1), `max_continues` (default 3; `stop` hooks per turn, §8),
`max_hook_text` (default 4000), `timeout_ms` (host wall clock; never part of replay: a host
that enforces it ends the run with `host_end`). All limits are non-negative integers.

### 12.2 Run end

`run_end.reason`: `stop`, `limit`, `infra_failure`, `host_end`. Infrastructure failures (model
API errors, unreachable tools or handlers, failed hooks) are never scored as model behaviour.
`limit` is the engine's own count and replays exactly; `host_end` is the host's decision (its
user left, `timeout_ms` passed) and happens in replay only where a recording says so (§14).

### 12.3 Live reload

A host MAY replace the harness during a run (for example after the agent edited its own file).
The new harness takes effect at the next step boundary of the top-level run (§8 step 3.1,
before interrupts are delivered, so the new `interrupt` hooks apply). The engine logs
`harness_changed` with the new hash, runs the new harness's `session_start` hooks,
re-assembles the system prompt (logged as a new `system` entry) and offers the new tool set,
hooks and limits from then on; the counters of the run go on, so a run that has already used up
the new `max_steps` ends with `limit` right there. A replacement that isn't a valid harness is
an infrastructure failure. Whether and how a harness edits itself is not part of
this spec.

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
- optional `user.jsonl`, `interrupts.jsonl` (with `step`) and `reloads.jsonl` (§12.3)
- `expected.log.jsonl`: the log
- `expected.requests.jsonl`: every rendered model request (§9)

Built-ins are computed, never recorded. Two engines conform iff both expected files are
byte-identical. `expected.requests.jsonl` is new compared with v0.3: **it tests the interface
itself**, i.e. exactly what a fine-tuned model would see.

**Recorded lines** (one JSON object per line):

| File | Line | Meaning |
|---|---|---|
| `model.jsonl` | `{text?, tool_calls?: [{tool, args}], reasoning?, reasoning_opaque?}` | the next response; `text` defaults to `""`, `tool_calls` to `[]` |
| | `{error}` | the model API failed |
| `tools.jsonl` | `{id, ok: true, result}` / `{id, ok: false, error}` | the next answer of a tool or handler binding |
| | `{id, unreachable: true}` | the binding couldn't be reached |
| `user.jsonl` | `{text}` | the next user message |
| `user.jsonl`, `model.jsonl` | `{end: true}` | the host ends the run here (`host_end`) |
| `interrupts.jsonl` | `{step, source, text}` | pushed while the run was at `step` (§8): queued once the current step reaches it |
| `reloads.jsonl` | `{step, harness}` | a replacement harness, taken at the first top-level step boundary where the current step has reached `step` |

The replay host answers from these files in order. A model `error`, an `unreachable` line, a
tools line whose `id` isn't the id being called, and a missing line in `model.jsonl` or
`tools.jsonl` are infrastructure failures. When `user.jsonl` has no more lines, the conversation
is over (§8 step 2). `expected.requests.jsonl` holds one canonical line per model request, in
order, child runs included.

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

**Resolved 2026-10-17 (build session):** the seen-only rule applies to what makes a check pass;
`since` resets and `core_count` count every finished call (§6). The invalid-arguments error
texts are fixed (§8). Every hook decision is logged, `allow` included (§7). The built-in
failure texts stay as drafted (§6); the `core_spawn` default description, input schema and
narrowing denials are fixed in §10.

**Resolved in review (release 0.5.0):** limits are checked with `≥`, and a reload's limits apply
at once (§8, §12.3); the host ends a run with `host_end`, which a recording can ask for, and
`timeout_ms` is enforced that way (§8, §12, §14); a child's `host_end` ends the whole run (§10);
malformed user messages and `reasoning_opaque` are infrastructure failures (§7, §8).

**The first hosts (release 0.5.0):** a Python command line running the chess harness with
`python-chess`, and a single HTML page running the TS engine with `chess.js`, the key pasted in,
the fixtures replayable in the page. Both give the model the same tokens for the same game. The
KIT gateway's CORS policy admits only its own origin, so the page talks to endpoints such as
OpenRouter that allow browser calls.

**Still open:**
1. **Images and other non-text results:** planned for a later version, after more host runs.
   Needs a fixed adapter rule for providers that don't accept images in tool results.
