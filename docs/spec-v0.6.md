# Harness Spec v0.6

**Status:** Normative, 2026-11-25. Release 0.6.0 implements it: the TypeScript and Python engines in this
repository produce byte-identical logs and requests for every fixture in `conformance/`. It is spec v0.5
([archived](archive/specs/spec-v0.5.md)) with five changes, the user's decision of 2026-11-25 after Mouseion
rebuilt the pi coding agent (pi 1.5.2) token for token on Fausth: tools are offered in the order the file
declares them (§9), the provider's tool-call ids are kept (§7), a call's arguments go back written as the
original harness writes them (§9.4), the engine's own texts can be worded in the file (§8.2), and
`replace_context` can keep the newest messages and leave its text unwrapped, with the last response's usage
and the logged reasoning in the `pre_request` hook input (§5.3, §5.4). Before 0.6 was tagged the user decided
two more things for Mouseion's second rebuild, Hermes Agent 0.22.6: the argument text has exactly two
defined forms, which a harness chooses with `argument_text` (§9.4), and 0.6 drops 0.5's files (Versions,
below). The decisions behind v0.5 are in [`primitives-inventory.md`](primitives-inventory.md) §6–§8.
**Versions:** until the user declares the spec stable, each version may break files of the previous one, and
an engine runs only files of its own version: a 0.6 engine rejects a `harness/0.5` file (§2). Backwards
compatibility starts once the spec is declared stable. (The user's decision, 2026-11-25.) How to move a file
from 0.5 to 0.6, and what then changes in the model's tokens, is in the CHANGELOG (0.6.0).
**Project name:** undecided. Built-ins use the neutral `core_` prefix; harness files declare
`spec: harness/0.6`.
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

**Member order.** Where this spec gives an object's members an order (the tools a model is offered, §9;
the argument text in the form `model_order`, §9.4), it is the order in which they appear in the document, except that members whose
names are array indexes (`0`, or digits without a leading zero, below 2^32 − 1) come first, in ascending
numeric order. That is the order ECMAScript gives an object's own keys, so `JSON.parse`, and a YAML reader
that builds plain objects, keep it without further work. A name that occurs twice keeps its first place and
its last value.

---

## 2. The harness file

YAML 1.2 (core schema; duplicate keys are an error) or JSON, which is read as YAML 1.2 (so
duplicate keys are an error there too). The document MUST denote a JSON value: string keys
only, finite numbers only, no tags outside the core schema. Authoring tools MAY support
includes (e.g. a prompt in a separate file, or another agent's harness in a hook's `with`, §13.1). What
an engine runs is the **resolved harness**: one JSON document with includes inlined, in which the order of
`tools` counts (§9).
`harness_hash` = `hash([<resolved harness>, <the ids of its tools in member order>])`: the canonical
form alone drops that order (§1). [`schema/harness.v0.6.json`](../schema/harness.v0.6.json) is the
JSON Schema of the file; the cross-references (§3.1, §5.1, §6) and the placeholders of `texts` (§8.2)
are checked in addition.

Top-level fields (closed set; anything else is a validation error):

| Field | Required | Meaning |
|---|---|---|
| `spec` | yes | `harness/0.6`. A 0.6 engine runs no other value (see Versions, above). |
| `name` | yes | Non-empty string. Not shown to the model. |
| `prompt` | yes | The system prompt text (§9.1). |
| `tools` | no | Model-facing tools (§3). The model is offered exactly these, in this order (§9). |
| `handlers` | no | Hook-only tools (§3). Never offered to the model. |
| `hooks` | no | Ordered list (§5). |
| `limits` | no | §12. |
| `texts` | no | The engine's own texts, worded for this harness (§8.2). |
| `argument_text` | no | How a call's arguments are written when they go back to the model: `model_order` (the default) or `sorted_ascii`, each defined byte for byte (§9.4). |

### Example: the chess harness from `cb-ability-v1` (arm S1G1p, with the stricter rule)

```yaml
spec: harness/0.6
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

Both maps are closed: no other members. The order of `tools` is the order in which the model is
offered them (§9). Schemas are JSON objects. An engine compiles every schema
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
`"*"`. A built-in's `with` holds exactly the members listed in §6, and its `tool` (every id of
a `tool` list) MUST be a declared tool; so MUST its `since`, unless it is the reserved value
`"@turn"` (§6).

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
  "step": 3,
  "turn": 0,
  "call": {"tool": "board_move", "args": {"move": "e2e4", "position_hash": "...", "reason": "..."}},
  "result": {"ok": true, "result": {}},
  "message": "<text>",
  "interrupt": {"source": "timer", "text": "..."},
  "context": [ <messages> ],
  "usage": {"prompt_tokens": 41230, "completion_tokens": 812},
  "view": [ <view entries> ]
}
```

Only the members that apply to the event are present: `call` for tool events, `result` for
`post_tool`, `message` for `user_prompt` and `stop`, `interrupt` for `interrupt`, `context`
(the rendered conversation, §9) and `usage` for `pre_request` and `stop`. `event`, `hook`, `with` (`{}`
when the hook has none), `step`, `turn` and `view` are always present. `call.args` are the arguments as
the chain has modified them so far (`post_tool`: the arguments the call ran with); `message` is the user's
text (`user_prompt`) or the response's `text` (`stop`); `context` is the `messages` of the
request as it would be rendered at that point, logged reasoning included (§9), so it includes
the chain's earlier `add_context`; `usage` is the `usage` of the run's last `assistant` entry (§7),
the token counts the provider reported for the last response as the host gave them, absent when that
entry has none or there is none. On `stop` the two are the same as on `pre_request`, taken after the
response without tool calls: `context` ends with that response (and the chain's earlier `add_context`),
and `usage` is that response's. A compaction handler measures the context with the two (Appendix A.3); a
`stop` handler can build a request of its own from them after the model's last reply, through a binding
that launches another run (§13.1, Appendix A.7). On `post_tool`, after a `replace` earlier in the chain,
`replaced` holds the text that replaces the result so far.

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

The hook input also carries `step` (the current step), `turn` and, for `stop`, `continued` (how
many `continue` decisions this turn has had so far, §8). `turn` is the current step at which the
run's latest user message was admitted: 0 before any, so a run with one user message has `turn`
0. Only an admitted user message starts a turn; an interrupt doesn't. A child run (§10) has its
own, from its task. It is the turn whose start resets the `continue` count (§8). Tool calls from the current step were
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
| `replace_context` | `text`, optional `keep`, `wrap` | the conversation after the system prompt is replaced by `text`, except its newest `keep` messages (§9.3) |

`keep` is a non-negative integer, at most the number of messages in the hook input's `context`: those
newest messages stay as they are, and the text replaces only the ones before them. `wrap` is a boolean:
`wrap: false` renders the text as the user message as it is, without the wrapper (§9.2), for a summary
that brings its own framing.

A decision not allowed for the event, missing members, a member of the wrong type, a `keep` above the
context's length, or an invalid `modify` → the hook **failed**. The same holds when the handler is
unreachable, returns `ok: false`, answers in neither form of §3.3, or its hook input fails its `input`
schema (§5.3). (Retrying is the host's job inside the binding, before it reports a failure.) A failed
hook writes a `hook` entry with `decision: "failed"` and no `text`; then:
- `on_failure: end` (default): the run ends with `infra_failure`. A rule that can't be checked
  must not silently pass, and an infrastructure problem must not show up in the model's tokens.
- `on_failure: skip`: the hook is treated as `allow`; the model sees nothing. Meant for
  advisory hooks (tips, context), never for rules.

`text` is excerpted to `limits.max_hook_text` code points (default 4000) before it is logged, except
the text of a `replace_context` with `wrap: false`, which is logged and rendered whole: it replaces the
conversation, and a summary is often longer.

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
| `core_called_since` | `tool` (an id or a list of ids), optional `since` | a seen successful call of `tool` (of any listed tool) exists after the last successful call of `since` (or anywhere, without `since` or when `since` has no successful call); with `since: "@turn"`, made in the current turn | `{tool} not called since the last {since}` / `{tool} not called yet`; with `"@turn"`, `{tool} not called this turn` |
| `core_last_result` | `tool`, `path`, `eq` | the last seen successful call of `tool` has `eq` at `path` | `last {tool} result {path} is not {eq}` / `{tool} has no successful call yet` |
| `core_count` | `tool`, `max` | fewer than `max` successful calls of `tool` exist | `{tool} limit reached ({max})` |
| `core_deny` | `text` | never | `{text}` |
| `core_context` | `text` | always; returns `add_context` with `text` | — |

`tool`, `since`, `path` and `text` are strings, `max` is a non-negative integer, `eq` is any JSON
value. `core_called_since` also takes a non-empty list of distinct tool ids as `tool`: the check
passes if any of them qualifies, and `{tool}` renders as the ids joined by
` or ` in the listed order (`board_check or board_piece not called yet`); a one-id list behaves as
the id. `since` may also be the reserved value `"@turn"` (an `@` can't occur in a tool id, §3.1):
then only calls made in the current turn count, those with `step` > `turn` (§5.3). A run that
spans several user messages asks "this turn" that way, which no tool id can express.
"Successful" is `ok: true` in the view. `core_called_since` uses its first failure text
when `since` has a successful call, else the second. `path` is a `.`-separated list of object
member names and array indexes (`0`, `1`, …, no leading zeros); `""` is the result itself; a
path that leads nowhere fails the check, and `eq` is compared by canonical form.
`{tool}` (an id), `{since}` and `{path}` render as given, `{max}` and `{eq}` as canonical JSON.

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
| `assistant` | `step`, `text`, `tool_calls: [{call_id, tool, args, args_text?, malformed?}]`, `reasoning?`, `reasoning_opaque?`, `usage?` |
| `hook` | `hook`, `event`, `decision`, `text?`, `args?`, `keep?`, `wrap?`, `call_id?` |
| `tool_result` | `call_id`, `tool`, `ok`, `result` or `error` |
| `interrupt` | `source`, `text`, `step` |
| `harness_changed` | `harness_hash` (§12.3) |
| `run_end` | `reason`: `stop` \| `limit` \| `infra_failure` \| `host_end` |

**Reasoning** (the model's thinking tokens) is always logged when the provider returns it:
plain text as `reasoning`, an encrypted or signed blob as `reasoning_opaque: {provider, data}`
(`provider` a string, `data` any JSON value). The log is the training data, and reasoning is its
most valuable part. A response that breaks this shape (§14 gives it) is an infrastructure
failure.

`call_id` is the id the model response gave the call (§14) if that is a non-empty string which no
earlier call in the log has (calls earlier in the same response included) and which isn't of the
engine's form `c<digits>-<digits>`. Otherwise the engine names the call `c<seq of the assistant
entry>-<index>`, with `index` counting the response's tool calls from 0. The model sees the ids it
wrote; the engine's form stays free for calls without one; and ids unique in the log keep each call's
entries, and a child's `parent_call` (§10), apart.

`args_text` is the call's argument text (§9.4), written in the form of the harness that ran the call, present
only when it differs from the canonical form of `args`. The model's own text for the arguments (a response
call's `raw`, §14) isn't logged: `args_text` holds what the model is shown. A call whose argument text
wasn't JSON (§14) is logged with `args: {}` and `malformed`: the text as the model sent it. `usage` is the
model response's `usage` (§14), as the host gave it.

Entries of a child run (§10) are written inline with `depth` = parent depth + 1 and
`parent_call` = the `call_id` of the `core_spawn` call. Top-level entries carry neither member,
except `run_start`, which always carries `depth`.

Member details: `assistant.text` is `""` when the response has no text, and `tool_calls` is
`[]` when it has no calls. A `hook` entry is written for **every** hook that runs, `allow`
included, in chain order (§5.2); it carries `call_id` on tool events, `text` when its decision
has one, `args` for `modify`, and `keep` and `wrap` when a `replace_context` has them. A
`tool_result` carries `result` iff `ok`, else `error`. An optional member is left out, never `null`.
Every line ends with `\n`.

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
      - Unknown tool → `tool_result` with `ok: false` and the `unknown_tool` text as `error`
        (§8.2); a call whose argument text wasn't JSON (`malformed`, §14) → the
        `malformed_arguments` text; arguments that fail the input schema → the
        `invalid_arguments` text, with the reasons of §8.1. No hooks run. (The default texts are
        fixed so that every engine and every schema library produces the same tokens.)
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

### 8.1 Why arguments fail

Whether arguments fit a tool's input schema is JSON Schema's verdict (§3.2). Why they don't is the
engine's own text, built from the schema and the arguments by the rules below, never from a schema
library's messages: so the model learns what to fix, and every engine says it in the same tokens.
The reasons are joined with `; `. When the rules find none, the reason is `does not match the
input schema`.

Let `S` be the input schema and `A` the arguments.

1. If `S` has `type: "object"` and `A` is not an object: `the arguments must be a JSON object`.
   No other rule applies.
2. If `A` is an object:
   1. each name in `S.required`, in its order, that `A` lacks: `missing required member <name>`;
   2. if `S.additionalProperties` is `false` and `S` has no `patternProperties`: each member of
      `A` that `S.properties` doesn't declare, its names in the order of canonical JSON (§1):
      `unknown member <name> (members: <names>)`, where `<names>` are `S.properties`' names in
      that order joined with `, ` (`(no members)` when it declares none);
   3. each member of `A` that `S.properties` declares, in the same order, checked against its
      schema `P`: the first row below that fails gives `<name>: <reason>`, and a value that fails
      none gives no reason.

| Row | Applies when | Fails when | Reason |
|---|---|---|---|
| `P` is `false` | always | always | `not allowed` |
| `type` | always | the value is of none of the types (an integer is a number without a fractional part) | `must be ` + `a string`, `an integer`, `a number`, `a boolean`, `an object`, `an array` or `null`, several joined with ` or ` in `type`'s order |
| `enum` | always | no entry has the value's canonical form | `must be one of ` + the entries' canonical forms joined with `, ` |
| `const` | always | its canonical form differs from the value's | `must be ` + its canonical form |
| `minLength` | the value is a string | it has fewer code points | `at least <n> characters (it has <k>)` |
| `maxLength` | the value is a string | it has more code points | `at most <n> characters (it has <k>)` |
| `pattern` | the value is a string | the pattern doesn't match (§3.2) | `must match the pattern <pattern>` |
| `minimum` | the value is a number | value < n | `at least <n>` |
| `exclusiveMinimum` | the value is a number | value ≤ n | `more than <n>` |
| `maximum` | the value is a number | value > n | `at most <n>` |
| `exclusiveMaximum` | the value is a number | value ≥ n | `less than <n>` |
| `minItems` | the value is an array | it has fewer items | `at least <n> items (it has <k>)` |
| `maxItems` | the value is an array | it has more items | `at most <n> items (it has <k>)` |

Numbers are written in canonical form (§1). Every reason names a real violation, so it can be
incomplete (a nested schema, `allOf`, a `$ref`) but never wrong. For example, with
`required: [move, reason]`, `additionalProperties: false` and `reason: {type: string, minLength: 20}`,
the arguments `{"move": "e2e4", "value": 3}` get `invalid arguments: missing required member
reason; unknown member value (members: move, reason)`, and `{"move": "e2e4", "reason": "aaaa"}`
get `invalid arguments: reason: at least 20 characters (it has 4)`.

A host MAY supply the reasons instead, as one text: its own validator's messages, as a rebuild of
another harness needs them. The engine then uses that text for `{reasons}` (§8.2), and the rules
above when the host gives none. The reasons reach the model only through the logged `error`, so a
replay of the log doesn't need the host.

### 8.2 The engine's texts

The texts the engine writes into tool results can be worded in the file's `texts`. Each is a
template: `{name}` (a name of lowercase letters and `_`) is a placeholder, replaced by its value;
every other character stays as written. Values are not escaped and not read again. A template may use
only its own placeholders; any other `{name}` makes the harness invalid.

| `texts` member | For | Placeholders | Default |
|---|---|---|---|
| `unknown_tool` | a call of a tool the harness doesn't offer | `tool`, `args`, `args_indented` | `invalid arguments: unknown tool` |
| `invalid_arguments` | arguments that fail the input schema | `tool`, `args`, `args_indented`, `reasons` | `invalid arguments: {reasons}` |
| `malformed_arguments` | an argument text that isn't JSON (§14) | `tool`, `text`, `parse_error` | `invalid arguments: the arguments must be a JSON object` |
| `tool_error` | how a failed result is shown (§9.3) | `error` | none: the canonical form of `{"error": <error>}` |

`tool` is the tool's name as the model called it; `args` is the call's argument text in the harness's form
(§9.4) and `args_indented` the same with two-space indentation, as that form defines it; `reasons` are those of §8.1, joined with `; `,
or the host's; `text` is the argument text as the model sent it and `parse_error` the response's
`parse_error`, `""` when it has none (§14); `error` is the result's `error`. The first three make the
`error` that is logged. `tool_error` applies whenever a failed result is rendered, whoever wrote its
error, so a harness whose model sees errors as plain text says `tool_error: "{error}"`. pi 1.5.2's
words, for example (its validator's reasons come from the host, §8.1):

```yaml
texts:
  unknown_tool: "Tool {tool} not found"
  invalid_arguments: "Validation failed for tool \"{tool}\":\n{reasons}\n\nReceived arguments:\n{args_indented}"
  malformed_arguments: "Invalid arguments for tool \"{tool}\": {parse_error}\n\nReceived arguments:\n{text}"
  tool_error: "{error}"
```

---

## 9. Rendering: what the model sees

The engine produces a provider-neutral request: `system` (string), `tools` (list), `messages`
(list of `user` / `assistant` / `tool` messages). Host adapters map it to a provider API without
changing any text. Its exact shape, which `expected.requests.jsonl` records (§14):

```json
{"system": "<text>",
 "tools": [{"name": "<id>", "description": "<text>", "input": {}}],
 "messages": [{"role": "user", "text": "<text>"},
              {"role": "assistant", "text": "<text>",
               "tool_calls": [{"call_id": "call_8f2a", "tool": "<id>", "args": {}, "args_text": "<text>"}],
               "reasoning": "<text>"},
              {"role": "tool", "call_id": "call_8f2a", "tool": "<id>", "text": "<text>"}]}
```

`tools` holds every entry of the harness's `tools` in member order (§1): the order the file declares
them, a tool whose id is an array index (`2`, `10`) first. `harness_hash` sees that order (§2).
After a live reload the tools are the new harness's, in its order: a tool it adds appears where it
declares it, and one it drops is gone (§12.3); a child run offers its own harness's (§10). `output`
schemas are not shown. An assistant message repeats its log entry's `text` and `tool_calls` (without
`malformed`), and its `reasoning` and `reasoning_opaque` when the entry has them (§7). An adapter sends
a call's argument text (§9.4) where the provider takes the arguments as text.

Logged reasoning rides in the neutral request, but it reaches the model only as the host adapter
sends it, following the provider's rules (some require it within a tool loop, some reject it).
An adapter takes `reasoning_replay`:

- `none`: no logged reasoning is sent back;
- `turn`: that of the assistant messages after the request's last user message, the current tool
  loop (a push-back or added context that renders as a user message starts a new one, §9.3);
- `all`: all of it.

The Chat Completions adapter sends `reasoning` as the assistant message's `reasoning_content` and
never sends `reasoning_opaque` back. Its default is `turn` (0.5.5; before, `none`): what GLM, DeepSeek
and Anthropic ask for within a tool loop, at few extra tokens. A host that wants another value says so.
Other provider extras (caching) are out of scope.

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
| tool result, `ok: false` | `{"error":"<error>"}` (canonical JSON), or the harness's `tool_error` text (§8.2) |
| `pre_tool` `deny` | the tool message for that call is the wrapper alone |
| `pre_tool` `modify` | the tool message is the wrapper (`text` or `args changed`), `"\n"`, then the result |
| `post_tool` `replace` | the tool message is the wrapper alone |
| `add_context` on a tool event | appended to that call's tool message: `"\n\n"` + wrapper |
| `add_context` on `user_prompt` | appended to the user's text: `"\n\n"` + wrapper |
| `add_context` on `interrupt` | appended to the interrupt's message: `"\n\n"` + wrapper |
| `add_context` on `pre_request`, `stop`; `stop` `continue` | a user-role message with the wrapper |
| delivered interrupt | a user-role message with the interrupt wrapper |
| `replace_context` | the messages after the system prompt, except the newest `keep`, are replaced by one user-role message: the wrapper, or with `wrap: false` the text itself |
| `allow`, `failed`, a `deny` on `user_prompt` or `interrupt` | nothing |

When several decisions concern one call, its tool message is built from its log entries in log
order: each `modify` adds its wrapper and `"\n"`; then comes the body, which is the `deny`
wrapper if a hook denied the call, else the wrapper of the last `replace`, else the result; then
each `add_context` adds `"\n\n"` + wrapper. The tool messages follow their assistant message in
call order; a call that never finished (the run ended first) has none. The `add_context`
decisions of a denied user message or interrupt are dropped with it.

Several user-role contributions in a row are **merged** into one user message, joined by
`"\n\n"`, in log order; the user's own messages count as contributions. The messages a
`replace_context` keeps stay as they were: the first of them doesn't merge into the replacing message.
The engine never emits system messages mid-conversation.

### 9.4 The argument text

The **argument text** of a call is the text of its arguments that goes back to the model. Every later
request shows the model its earlier calls, and a provider that takes arguments as text (Chat Completions'
`arguments`) gets this text; it is also the `{args}` of the engine's texts (§8.2). So it is part of what the
model sees, as much as the prompt or a tool result.

Real harnesses don't send back the text the model wrote. They parse the arguments and write them again with
their language's JSON writer, and writers differ: in the order of members, in which characters they escape,
in how they write numbers. pi (TypeScript) writes the parsed value with `JSON.stringify`; Hermes Agent (Python)
writes it with `json.dumps(…, sort_keys=True)`. A model that wrote `{"path": "a.txt", "content": "é"}` is
shown `{"path":"a.txt","content":"é"}` by one and `{"content":"\u00e9","path":"a.txt"}` by the other, from
its second request on. A rebuild that writes differently than its original changes those tokens.

So a harness names the form of its argument text, `argument_text`, and there are exactly two. Each
reproduces one real serializer byte for byte and is in the spec because a recorded harness needed it:

| `argument_text` | Writes what this writes | Needed by |
|---|---|---|
| `model_order` (default) | ECMAScript: `JSON.stringify(JSON.parse(text))` | pi 1.5.2 (TypeScript), Mouseion's first rebuild: 18 recordings replay byte for byte |
| `sorted_ascii` | Python: `json.dumps(json.loads(text), separators=(",", ":"), sort_keys=True)` | Hermes Agent 0.22.6 (Python), Mouseion's second rebuild: its source writes arguments so (`_canonicalize_tool_call_arguments`), and a recorded Terminal-Bench trial shows them sorted |

The set is closed. `argument_text` is not a formatting option to tune: each value names the serializer of
a real harness, and an engine that implements it writes exactly that serializer's bytes. A third form is
added only by a change of this spec, backed by a recorded harness that needs it, and defined here as
exactly as these two.

`text` is the model's argument text: the response call's `raw` (§14), or, when it has none, the
`model_order` text of its `args`. `sorted_ascii` needs it because a JSON reader that makes a double of every
number (§1) has forgotten whether the model wrote `1` or `1.0`, and the digits of a large integer;
`model_order` gives the same text either way. The Chat Completions adapters pass `raw` whenever the
provider sends the arguments as JSON text.

**`model_order`.** For the value a JSON reader makes of the model's text (`args`): compact JSON, no
whitespace between tokens; members in member order (§1), so names in the model's order with array indexes
first; strings and numbers as in the canonical form (§1): only `"`, `\` and characters below U+0020 escaped,
other characters as they are; numbers as ECMAScript writes doubles (`1.0` as `1`, `1e2` as `100`, `1e21` as
`1e+21`). With two-space indentation (`{args_indented}`) it is `JSON.stringify(value, null, 2)`: each member
and item on its own line, `": "` after a name, `[]` and `{}` for empty ones.

**`sorted_ascii`.** Read `text` as Python's `json.loads` reads it:
- a number token without `.`, `e` or `E` is an integer and stays exact, all its digits (`18446744073709551615`
  stays; `-0` is `0`); any other number token is the nearest double (`1.0`, `1e2`, `0.1`);
- a name that occurs twice keeps its last value.

Then write it compactly, with no whitespace between tokens:
- an object's members sorted by name, the names compared code point by code point (Python's order, not
  UTF-16 code units: `"\uffff"` comes before `"🙂"`, which canonical form puts the other way round); an
  array's items in their order;
- a string in `"`: `"` and `\` as `\"` and `\\`; U+0008, U+0009, U+000A, U+000C and U+000D as `\b`, `\t`,
  `\n`, `\f` and `\r`; every other character outside U+0020–U+007E as `\u` and four lowercase hex digits
  (`é` as `\u00e9`, U+007F as `\u007f`, U+0000 as `\u0000`), and a character above U+FFFF as its UTF-16
  surrogate pair (`🙂` as `\ud83d\ude42`); `/` stays as it is;
- an integer as its decimal digits;
- a double as Python's `float.__repr__` writes it. Take the shortest digits `d₁d₂…dₖ` that read back as the
  double (the digits ECMAScript writes too) and its exponent `e`, so that the double is `d₁.d₂…dₖ × 10^e`. If
  −4 ≤ e < 16, write it with a decimal point and at least one digit after it (`1.0`, `100.0`, `0.0001`,
  `1000000000000000.0`, `0.1`); otherwise as `d₁`, then `.d₂…dₖ` if k > 1, then `e`, the exponent's sign and
  at least two digits (`1e-05`, `1e-07`, `1e+16`, `1.2345678901234569e+23`, `5e-324`). Zero is `0.0`,
  negative zero `-0.0`, any other negative double `-` and the rest;
- `true`, `false` and `null` as they are.

With two-space indentation (`{args_indented}`) it is `json.dumps(json.loads(text), indent=2,
sort_keys=True)`: the same, each member and item on its own line, `": "` after a name, `[]` and `{}` for
empty ones. `conformance/values.json` holds vectors for both forms.

The argument text is written when the call is logged, in the form of the harness that runs the call: a
child's own (§10); after a reload, the new harness's for new calls, while the calls already logged keep
theirs (§12.3). The log keeps it as `args_text` when it differs from the canonical form of `args` (§7), and
the request carries it the same way: a call's argument text is its `args_text`, else the canonical form of
its `args`. So a log replays without the model's text. A call whose text wasn't JSON goes back as `{}` (its
`args`) in either form: a provider that reads the arguments of earlier calls would reject the broken text,
and the error tells the model (§8.2).

**Known differences.** Where an original does more around its serializer, Fausth doesn't follow, and a
rebuild's replay differs from the recording there:
- Hermes repairs arguments it can't parse (`_repair_tool_call_arguments`) and sends the repaired text back;
  Fausth sends `{}` and the `malformed_arguments` text (§8.2).
- Python reads `NaN`, `Infinity` and `-Infinity`, and a number too large for a double as infinity, and
  writes them back as `NaN` and `Infinity`. They aren't JSON (§1): the first three make the text `malformed`,
  and a value with an infinity breaks the interface (§14).
- Python reads a lone surrogate escape (`"\ud800"`) into a string. Such a string has no canonical form (§1),
  so the response breaks the interface (§14).

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
logged inline (§7), with its own harness's tools, order, texts and argument text (§9.4). Its view holds only its own calls (§5.3); the current step counts every request in the log,
the child's included (§8).

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

**`core_spawn` and a launched run.** A tool or handler can also be bound to another Fausth run that the
environment launches (§13.1). Both run a harness on a task; they differ in who starts the run and what it
takes from the caller:

| | `core_spawn` | a binding that launches a run (§13.1) |
|---|---|---|
| Started by | the engine, for the model's call | the host, for a call of the tool or handler bound to it |
| Its harness | the model's, in the call's arguments | the one handed to the binding: by the calling file in a hook's `with`, or by the model in a tool's arguments |
| Checked | the narrowing check above | valid, and every id bound by its deployment |
| The caller's hooks | inherited, run first | none |
| Log | inline in the caller's: `depth` + 1, `parent_call` | its own: a top-level run |
| Steps and limits | counted against the parent's; one current step | its own |
| Bindings, transport | the parent's | its deployment's, with request parameters of its own |
| The caller gets | `{text, steps, tool_calls}` | the binding's answer (§3.3), made from how the run ended |
| Replay | in the caller's fixture | in a fixture of its own; the caller's records the answer |
| Its `infra_failure`, `host_end` | end the whole run the same way | the binding's infrastructure failure |

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
re-assembles the system prompt (logged as a new `system` entry) and offers the new tool set (in its
order, §9), hooks, limits, texts and argument text from then on (a new `tool_error` shows every failed
result in the conversation, earlier ones included; a call already logged keeps its argument text, §9.4); the counters of the run go on, so a run that has already used up
the new `max_steps` ends with `limit` right there. A replacement that isn't a valid harness is
an infrastructure failure. Whether and how a harness edits itself is not part of
this spec.

---

## 13. Deployment (host side)

The deployment file is **not** part of the harness and never changes what the model sees. It
holds:
- **Bindings:** for every tool and handler id, an implementation: `script`, `http`, `mcp`,
  `model` (a prompt plus model id), `human`, `recorded`, or `harness` (another Fausth run, §13.1). A
  `human` binding MUST be answered by a human or a declared simulator, never from the acting model's own
  arguments.
- **The model transport.**
- **Sandbox, filesystem scopes, secrets, protected paths:** enforced by the host's tool
  implementations.

A deployment that leaves a declared id unbound is rejected before the run starts.

### 13.1 A binding that launches another run

A tool or handler can be bound to **another Fausth run**, launched by the environment, not by the engine:
the binding runs the harness it is handed as a separate run (§8) with its own log and its own limits, whose
only user message is a task the binding makes from its input. A handler's binding is handed the harness in
its hook's `with` (by convention `with.harness`), so the calling file names its sub-agent; a tool's in its
arguments (by convention `harness`), so an orchestrator's model can write a sub-agent at runtime. The
deployment says only that the id launches the harness it is handed, how the task is made (a title binding
on `stop` takes the opening user message from the hook input's `context`, strips the host's wrappers and
cuts it to `with.max_chars` characters) and how the run's end becomes the binding's answer (§3.3): for a
tool typically the text of the run's last assistant entry, for a handler a hook decision (§5.4), such as
`allow` once the run has done its work.

**One file per agent, one document.** Each agent's harness can be a file of its own, and the calling file
brings it into the hook's `with` with an include (§2). What an engine runs is the resolved harness, so all of
a system's harnesses are in one document and the caller's `harness_hash` covers its sub-agents; the launched
run's `run_start` carries the hash of the harness it was handed. (This spec standardises no include syntax,
Appendix B.)

The spec guarantees:
- **A handed harness that can't run is not launched.** One that isn't valid (§2, §3, §5.1), or that declares
  an id the launched run's deployment doesn't bind, gets the answer `{ok: false, error: "child harness is
  not valid"}`, `core_spawn`'s words (§10): world feedback the model sees for a tool (§3.3), a failed hook
  for a handler (§5.4).
- **A run of its own.** The launched run is a top-level run in a log of its own: its own `run_start` (depth
  0), its own current step from 0, its own counters, its harness's limits. Nothing of it counts against the
  caller's limits, and none of its entries is in the caller's log or view.
- **No inherited hooks, no narrowing.** None of the caller's hooks runs in it, and it isn't checked against
  the caller's harness. The calling file's author wrote a handler's sub-agent, not the model, so the reason
  for §10's inheritance doesn't apply; and a `stop` hook that launches a title run would otherwise ask for a
  title of that run too.
- **The caller's log records the answer only**, as for any binding: the `tool_result` or the `hook` entry.
  It doesn't point to the launched run: its entries are fixed (§7), and a reference in a tool's result would
  be put in front of the model. The host files the launched run's log so it can be found from the caller's,
  for example named after the caller's log, the binding's id and the launch's number.
- **Replay.** The caller's fixture records the binding's answer in `tools.jsonl` like any other (§14); the
  launched run replays from a fixture of its own. Each log replays alone, and what the calling model sees
  stays a function of its harness and its log (§0).
- **Failures.** A launched run that ends with `stop` or `limit` gives the binding what the binding makes of
  it. One that ends with `infra_failure` or `host_end`, or a task that isn't a string, leaves the binding
  without an answer: an infrastructure failure of the binding (§3.3), so a tool's ends the calling run with
  `infra_failure` and a handler's fails its hook (`on_failure`, §5.4).
- **The engine is unchanged.** There is no `spawn` decision and the run loop (§8) is the same; the binding
  is the host's like any other.

The host's:
- **Its requests** are rendered by §9 and go through the host's transport like any other. The host MAY give
  them request parameters of their own, which the neutral request doesn't carry: Hermes Agent's title
  request is not streamed and has `reasoning_effort: "none"` and a JSON `response_format`.
- **Its bindings.** The handed harness's ids are bound by the launched run's deployment, which may share
  implementations with the caller's. What a launched run can reach is what that deployment binds: the rule
  that a child never gets more than its parent (§0, §10) is `core_spawn`'s, so a deployment that binds a
  model-facing tool this way gives the model whatever those bindings give.
- **Its interrupts and reloads.** The caller's interrupts aren't delivered to it (§11); its host may give it
  its own.
- **When it runs:** inside the binding's call. A host MAY start it in the background when the binding's
  answer doesn't depend on it (a title binding answers `allow` either way); then its failure can't reach the
  caller and is the host's to report.
- **The clock.** The caller's `timeout_ms` (§12.1) runs on while the binding waits.

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
| `model.jsonl` | `{text?, tool_calls?: [call], reasoning?, reasoning_opaque?, usage?}` | the next response; `text` defaults to `""`, `tool_calls` to `[]` |
| | `{error}` | the model API failed |
| `tools.jsonl` | `{id, ok: true, result}` / `{id, ok: false, error}` | the next answer of a tool or handler binding |
| | `{id, unreachable: true}` | the binding couldn't be reached |
| `user.jsonl` | `{text}` | the next user message |
| `user.jsonl`, `model.jsonl` | `{end: true}` | the host ends the run here (`host_end`) |
| `interrupts.jsonl` | `{step, source, text}` | pushed while the run was at `step` (§8): queued once the current step reaches it |
| `reloads.jsonl` | `{step, harness}` | a replacement harness, taken at the first top-level step boundary where the current step has reached `step` |

A `call` is `{tool, args, raw?, call_id?}`, or `{tool, malformed, parse_error?, call_id?}` when the
model's argument text isn't JSON: `call_id` is the provider's id for the call (§7); `raw` (a string) the
model's argument text as it sent it, which read as JSON (§1) MUST give `args`, the same canonical form
(§9.4); `malformed` the text that isn't JSON, `parse_error` (a string) the host's JSON reader's message for
it, and `usage` (an object) the token counts the provider reported (§5.3). A host's model response has the
same shape; anything else is an infrastructure failure.

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

**A.3 Compaction.** A `pre_request` hook runs a handler that measures `context`, starting from
`usage`, the tokens the provider counted for the last response; above a threshold it asks a model for
a summary and returns `replace_context` with the summary, `keep` for the newest messages it leaves as
they are, and `wrap: false` when the summary brings its own framing. Mouseion's rebuild of pi 1.5.2
compacts like pi this way (its handler's binding holds pi's trigger, cut and summary requests).

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

**Resolved 2026-10-26 (the user, after harness-lab's reasoning-replay-v1):** the adapters' default
`reasoning_replay` is `turn` (§9). Sending all earlier reasoning back restored much of GLM's reasoning
in one long conversation, but it doubled the tokens, so `all` stays a host's explicit choice.

**Resolved 2026-11-25 (the user, after Mouseion's rebuild of pi 1.5.2, its gaps 1, 2, 3, 5 and 7):**
tools in the order the file declares them (§9); the provider's call ids kept (§7); arguments sent back
as pi writes them (§9.4, `model_order`); the engine's texts worded in the file (§8.2); `replace_context` with
`keep` and `wrap: false`, and `usage` and the logged reasoning in the `pre_request` hook input (§5.3,
§5.4). Gaps 4 (pi repairs arguments before checking them) and 6 (host values in the prompt) get no spec
change.

**Resolved 2026-11-25, before 0.6 was tagged (the user, for Mouseion's second rebuild, Hermes Agent
0.22.6):** the argument text is a per-harness setting, `argument_text`, with exactly two forms (§9.4):
`model_order`, which pi needs and 0.6 already had, and `sorted_ascii`, which Hermes needs (it writes earlier
calls' arguments back with Python's `json.dumps(…, separators=(",", ":"), sort_keys=True)`). The user asked
for it to be documented so that it can't be read as a setting the spec changes at will: each form is
defined byte for byte and traced to the serializer it reproduces and the recordings that needed it, and a
new form needs a spec change backed by a recorded harness. `sorted_ascii` follows Hermes's source and the
arguments of a recorded trial; Mouseion's replays of Hermes recordings are still to come. Hermes's repair
of unparseable arguments and Python's `NaN` and `Infinity` are known differences, not built.

**Resolved 2026-11-25, before 0.6 was tagged (the user):** no compatibility with 0.5. Each version may
break files of the previous one until the user declares the spec stable, and an engine runs only its own
version (Versions, above). In the user's words: compatibility can still break upwards each version; when
the spec needs no more changes for now, backwards compatibility starts. So 0.6 has no section for 0.5
files, and the conformance fixtures written for 0.5 declare `harness/0.6`.

**Still open:**
1. **Images and other non-text results:** planned for a later version, after more host runs.
   Needs a fixed adapter rule for providers that don't accept images in tool results.
2. **A check after the last reply.** pi checks the context again after a run's last reply and may
   compact then. `stop` allows only `continue` and `add_context`, and its input has no `context`. In a
   one-shot run this changes nothing the model sees (no one reads that summary). In a conversation the
   next request's `pre_request` hook can compact instead, but by then the context holds the next user
   message, which pi's summary leaves out, so trigger and cut can differ. Proposal, not adopted: `stop`
   also allows `replace_context`, with `context` and `usage` in its input as for `pre_request`.
3. **Asking again after compacting.** pi drops a reply cut off below its token limit, compacts and asks
   again. An engine step can't be asked again, so a rebuild can't do this on the engine's side; it never
   happened in Mouseion's recordings.
4. **Validators' own messages.** Identical texts for invalid arguments need the original's validator
   messages (pi-schema's); a host supplies them (§8.1). No general rule for them is planned.
