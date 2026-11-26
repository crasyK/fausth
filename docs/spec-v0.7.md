# Harness Spec v0.7

**Status:** Normative, 2026-11-26. Release 0.7.0 implements it: the TypeScript, Python and Rust engines in this
repository produce byte-identical logs and requests for every fixture in `conformance/`. It is spec v0.6
([archived](archive/specs/spec-v0.6.md)) with four changes, the user's decision of 2026-11-26 after the first review
round of Mouseion, whose rebuilds of pi 1.5.2, Hermes Agent 0.22.6, OpenCode 2.2.7 and mini-swe-agent 2.4.6 replay
recordings of the originals token for token and had to stand in for these four on the host's side:
- **a hook on the model's reply**, `post_response`, after the reply is logged and before any of its calls run: it can
  change which calls run and under what names, ask the model again (with a message, keeping or dropping the reply,
  after replacing the context), or end the run (§4, §5.4, §8); `end` is also a `post_tool` decision, and a run a
  hook ended ends with the new reason `harness_end` (§12.2);
- **argument repair before the schema check**, the event `pre_check`, whose `modify` says whether later requests show
  the model's argument text or the repaired one (§4, §5.4, §8);
- **a third argument-text form**, `as_sent`: the model's own text, byte for byte (§9.4);
- **the host's values in the file:** a `user_prompt` hook can `replace` the user's message (§5.4), and `${NAME}`
  placeholders in the prompt and the tool descriptions are filled when the file is loaded, from a fixed set of
  standard names and the names the file declares (§2.1).

The decisions behind v0.5 are in [`primitives-inventory.md`](primitives-inventory.md) §6–§8, those of 0.6 and 0.7 in
Appendix B.
**Versions:** until the user declares the spec stable, each version may break files of the previous one, and
an engine runs only files of its own version: a 0.7 engine rejects a `harness/0.6` file (§2). Backwards
compatibility starts once the spec is declared stable. (The user's decision, 2026-11-25.) How to move a file
from 0.6 to 0.7, and what then changes in the model's tokens, is in the CHANGELOG (0.7.0).
**Project name:** undecided. Built-ins use the neutral `core_` prefix; harness files declare
`spec: harness/0.7`.
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
an engine runs is the **resolved harness**: one JSON document with includes inlined and the host's values filled
in (§2.1), in which the order of `tools` counts (§9).
`harness_hash` = `hash([<resolved harness>, <the ids of its tools in member order>])`: the canonical
form alone drops that order (§1). [`schema/harness.v0.7.json`](../schema/harness.v0.7.json) is the
JSON Schema of the file; the cross-references (§3.1, §5.1, §6) and the placeholders of `texts` (§8.2)
are checked in addition.

Top-level fields (closed set; anything else is a validation error):

| Field | Required | Meaning |
|---|---|---|
| `spec` | yes | `harness/0.7`. A 0.7 engine runs no other value (see Versions, above). |
| `name` | yes | Non-empty string. Not shown to the model. |
| `prompt` | yes | The system prompt text (§9.1). |
| `tools` | no | Model-facing tools (§3). The model is offered exactly these, in this order (§9). |
| `handlers` | no | Hook-only tools (§3). Never offered to the model. |
| `hooks` | no | Ordered list (§5). |
| `limits` | no | §12. |
| `texts` | no | The engine's own texts, worded for this harness (§8.2). |
| `argument_text` | no | How a call's arguments are written when they go back to the model: `model_order` (the default), `sorted_ascii` or `as_sent`, each defined byte for byte (§9.4). |
| `host_values` | no | The names of the host's values the file uses beyond the standard ones (§2.1). |

### Example: the chess harness from `cb-ability-v1` (arm S1G1p, with the stricter rule)

```yaml
spec: harness/0.7
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

### 2.1 Host values

Real harnesses write facts about the machine they run on into what the model reads: the working directory, the
date, the model's name. A file writes such a value as a placeholder, `${NAME}`, and the host fills it in when it
loads the file. So the file still holds every text the model reads, and the host supplies only the values.

**Where.** Placeholders are filled in `prompt` and in the `description` of every entry of `tools`, nowhere else:
`texts`, `with` and handler descriptions are taken as written. A harness handed to a binding that launches another
run (§13.1), such as a sub-agent's in a hook's `with`, is filled when that run is launched, with the launching
host's values. A `core_spawn` child's harness (§10) is the model's text and is not filled.

**Names.** `NAME` matches `[A-Z][A-Z0-9_]*`. It is a **standard** name (below) or one the file declares in
`host_values`: a list of distinct names, none of them standard. A standard name has one meaning and one exact form,
so every host fills it alike; a harness that writes the same fact another way (another date format) declares a name
of its own.

| Name | Value |
|---|---|
| `CWD` | the run's working directory: an absolute path, its parts separated by `/` |
| `HOME` | the home directory of the user the run acts for: an absolute path |
| `DATE` | the local date when the run starts: `YYYY-MM-DD` |
| `YEAR` | that date's year: four digits |
| `TIMEZONE` | the local time zone's offset from UTC when the run starts: `UTC+HH:MM` or `UTC-HH:MM` (`UTC+00:00` for UTC) |
| `OS` | the operating system as `uname -s` names it (`Linux`, `Darwin`); `Windows_NT` on Windows |
| `MODEL` | the model's id as the run's requests name it (Chat Completions: the request's `model`) |
| `PROVIDER` | the host's id for the provider that serves the model, as its configuration names it |

**Filling.** At load, the host gives a map from names to strings, with a value for every name the file uses (more
are allowed). Each text is filled in three steps:
1. **Blocks.** A paragraph `${if NAME}` … `${end}`, that is the text `\n\n${if NAME}\n` + *body* + `\n${end}` where it
   is followed by `\n\n` or the end of the text (the shortest such *body*), becomes `\n\n` + *body* when the value of
   `NAME` isn't `""`, and disappears when it is. Blocks don't nest.
2. **Slots.** A paragraph that is only a placeholder, `\n\n${NAME}` followed by `\n\n` or the end of the text,
   disappears when the value is `""`.
3. **Placeholders.** In one pass from left to right, every `${NAME}` becomes its value and every `$${` becomes `${`
   (so `$${HOME}` writes `${HOME}` itself). Any other `$` stays as it is. Values are not read again: a value that
   holds `${HOME}` stays as it is.

A placeholder whose name is neither standard nor declared, a name without a value, a value that isn't a string, and
a `${if NAME}` or `${end}` that is not part of a block (step 3 meets it) are **load errors**: the harness is not run.
The filled harness is the resolved harness (§2): `harness_hash` covers the filled texts, so two runs whose values
differ have different hashes, and the `system` entry logs the filled prompt (§7). A file is filled once.

The three forms are what the rebuilt harnesses need: pi 1.5.2 and OpenCode 2.2.7 write placeholders (OpenCode also
in a tool's description: `The current year is ${YEAR}.`); Hermes Agent 0.22.6 also leaves out its toolchain line,
its git snapshot and its project files when it has none (slots) and its coding brief and WSL note when they don't
apply (blocks).

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
| `user_prompt` | for every user message (including the first) | — | `deny`, `replace`, `add_context` |
| `pre_request` | before every model request | — | `replace_context`, `add_context` |
| `post_response` | after every model response is logged, before any of its calls runs | — | `modify`, `retry`, `end` |
| `pre_check` | before a call of a declared tool is checked against its input schema | tool ids | `modify` |
| `pre_tool` | before each tool call executes | tool ids | `deny`, `modify`, `add_context` |
| `post_tool` | after each tool call executed | tool ids | `replace`, `add_context`, `end` |
| `stop` | the model answered without tool calls | — | `continue`, `add_context` |
| `interrupt` | an interrupt is about to be delivered (§11) | sources | `deny`, `add_context` |

`allow` (no change) is valid for every event. There are no subagent events: spawning is the tool
`core_spawn` (§10), so `pre_tool` / `post_tool` with `match: core_spawn` cover it. There is no
compaction event: compaction is a `pre_request` hook (Appendix A.3), or a `post_response` `retry` that
replaces the context before it asks again (§5.4).

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

`match` is only valid on `pre_check`, `pre_tool` and `post_tool`, where every id MUST be a declared
tool, and on `interrupt`, where the ids are sources (§11). A list is non-empty and doesn't contain
`"*"`. A built-in can't run on `post_response` or `pre_check` (§6). A built-in's `with` holds exactly the members listed in §6, and its `tool` (every id of
a `tool` list) MUST be a declared tool; so MUST its `since`, unless it is the reserved value
`"@turn"` (§6).

### 5.2 Order

The hooks matching an event run **one after another, in declaration order**.
- The first `deny` (or `replace_context`, `continue`, `retry` or `end`) ends the chain for that event.
- `modify` chains: the next hook sees the modified arguments (`pre_check`, `pre_tool`) or calls
  (`post_response`).
- `replace` chains: on `post_tool` the next hook sees the replaced text, but `result` stays the
  original world result; on `user_prompt` the next hook's `message` is the replacing text.
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
  "reply": {"text": "<text>", "tool_calls": [ <calls> ], "finish": "tool_calls"},
  "interrupt": {"source": "timer", "text": "..."},
  "context": [ <messages> ],
  "usage": {"prompt_tokens": 41230, "completion_tokens": 812},
  "view": [ <view entries> ]
}
```

Only the members that apply to the event are present: `call` for tool events (`pre_check`, `pre_tool`,
`post_tool`), `result` for `post_tool`, `message` for `user_prompt` and `stop`, `reply` for `post_response`,
`interrupt` for `interrupt`, `context` (the rendered conversation, §9) and `usage` for `pre_request`,
`post_response` and `stop`. `event`, `hook`, `with` (`{}`
when the hook has none), `step`, `turn` and `view` are always present. `call.args` are the arguments as
the chain has modified them so far (`pre_tool`: after the `pre_check` hooks' modifications too; `post_tool`: the
arguments the call ran with). On `pre_check`, `call` also carries `raw`, the model's argument text when the
response gave one (§14), and `malformed`, the model's text when it wasn't JSON (§9.4) and no hook in the chain
has modified the call yet; `call.tool` is the name the call runs under (§5.4, `post_response`). `message` is
the user's text as the chain has replaced it so far (`user_prompt`) or the response's `text` (`stop`); `reply`
is the response as its `assistant` entry logs it (§7): `text`, `tool_calls`, and `reasoning`,
`reasoning_opaque`, `finish` and `failure` when it has them, each call also with `raw` when the response gave
one; after a `modify` earlier in the chain, `tool_calls` are the calls as modified. `context` is the `messages`
of the request as it would be rendered at that point, logged reasoning included (§9), so it includes
the chain's earlier `add_context`; on `post_response` it is the `messages` of the request this response
answers (the response itself is `reply`); `usage` is the `usage` of the run's last `assistant` entry (§7),
the token counts the provider reported for the last response as the host gave them, absent when that
entry has none or there is none (on `post_response`, the response's own). On `stop` the two are the same as
on `pre_request`, taken after the response without tool calls: `context` ends with that response (and the chain's earlier `add_context`),
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
| `modify` | `pre_tool`: `args`, optional `text`; `pre_check`: `args`, `shown`, optional `args_text`; `post_response`: `calls` | `pre_tool`: the call executes with `args` (validated against the tool's input schema again). `pre_check`: the call is checked with `args` instead of the model's arguments. `post_response`: only the listed calls run (below). |
| `replace` | `text` | `post_tool`: the model sees `text` instead of the result. `user_prompt`: `text` is the user's message (below). |
| `continue` | `text` | the model is asked to keep going |
| `replace_context` | `text`, optional `keep`, `wrap` | the conversation after the system prompt is replaced by `text`, except its newest `keep` messages (§9.3) |
| `retry` | optional `text`, `wrap`, `keep_reply`, `replace_context` | none of the reply's calls runs, and the model is asked again (below) |
| `end` | optional `text` | the run ends with `harness_end` (§12.2) |

`keep` is a non-negative integer, at most the number of messages in the hook input's `context`: those
newest messages stay as they are, and the text replaces only the ones before them. `wrap` is a boolean:
`wrap: false` renders the text as the user message as it is, without the wrapper (§9.2), for a summary
that brings its own framing.

**`modify` on `pre_check`.** `args` (any JSON value) replace the arguments the model sent, and the call is then
checked against the tool's input schema with them as any call is (§8), so arguments that still don't fit get the
`invalid_arguments` text; a call whose text wasn't JSON is no longer `malformed`. `args` are not checked when the
hook decides. `shown` says which argument text later requests show for the call (§9.4): `model`, the model's own
(the repair is for running the call only, as OpenCode's), or `modified`, the modified arguments (as Hermes Agent
sends its repaired text back): `args_text` when the hook gives it, a string that, read as JSON (§1), gives `args`;
else `args` written in the harness's form as for a call without `raw`. The `assistant` entry keeps what the model
sent; the `hook` entry logs `args`, `shown` and, with `modified`, that text when it differs from the canonical form
of `args` (§7). When several hooks modify a call, the last one's `shown` holds.

**`modify` on `post_response`.** `calls` is a list of objects `{call_id, tool}`: each `call_id` that of one of the
reply's calls, none twice, and `tool` a string. Only the listed calls run, in the listed order, each under its
`tool` with its own arguments; the reply's other calls don't run and get no tool message. Later requests show the
reply with these calls, in this order, under these names (§9.3), as Hermes Agent repairs a mistyped tool name and
removes a duplicate call before it runs anything. A reply whose calls a `modify` removed is a reply without tool
calls (§8 step 7).

**`replace` on `user_prompt`.** `text` is the message that is admitted: the `user` entry logs it, and the model sees
it as the user's message, without the wrapper. The `hook` entry keeps the decision, so the log shows that a hook
made the message; mini-swe-agent sends the task inside a template that it fills at run time with the task and the
machine.

**`retry`.** The reply is not answered: none of its calls runs, and the engine asks the model again (§8 step 3), a
request that counts toward `max_steps` like any other. Before it asks:
- `keep_reply` (a boolean, default `false`): with `false` the reply is no longer rendered, so the next request is
  the one it answered plus what the decision adds; with `true` it stays in the conversation as it is, as OpenCode
  keeps a reply cut off at its output limit and asks the model to go on.
- `replace_context` (an object in that decision's shape: `text`, optional `keep` and `wrap`): the conversation the
  reply answered, the hook input's `context`, is replaced as a `replace_context` decision replaces it, before the
  kept reply: pi and OpenCode compact and ask again.
- `text` (a string): a user-role message added last, with the wrapper; with `wrap: false` the text itself, as a
  message of its own that is never merged with a neighbouring user-role contribution (§9.3), as mini-swe-agent sends
  its format error after the request's last user message.

The engine sets no limit on retries beyond `max_steps`: a handler that stops retrying (mini-swe-agent ends its run at
the third format error in a row) counts its earlier decisions in the log or keeps its own count.

**`end`.** The run ends with `harness_end`. On `post_response` none of the reply's calls runs; on `post_tool` the
reply's later calls don't run and get no tool message, as mini-swe-agent ends its run once a command's output starts
with its submit line. `text` says why: it is logged, not shown.

A decision not allowed for the event, missing members, a member of the wrong type, a `keep` above the
context's length, an invalid `pre_tool` `modify`, a `post_response` `modify` that names a call the reply doesn't
have or one twice, an `args_text` with `shown: model` or one that doesn't read as `args` → the hook **failed**. The same holds when the handler is
unreachable, returns `ok: false`, answers in neither form of §3.3, or its hook input fails its `input`
schema (§5.3). (Retrying is the host's job inside the binding, before it reports a failure.) A failed
hook writes a `hook` entry with `decision: "failed"` and no `text`; then:
- `on_failure: end` (default): the run ends with `infra_failure`. A rule that can't be checked
  must not silently pass, and an infrastructure problem must not show up in the model's tokens.
- `on_failure: skip`: the hook is treated as `allow`; the model sees nothing. Meant for
  advisory hooks (tips, context), never for rules.

`text` is excerpted to `limits.max_hook_text` code points (default 4000) before it is logged, except
an unwrapped text (`wrap: false`, of a `replace_context`, also one inside a `retry`, or of a `retry`) and the text
of a `user_prompt` `replace`, which are logged and rendered whole: they replace or make a message, and a summary or
a task is often longer.

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
| `post_response`, `pre_check` | not allowed (validation error) |

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
| `assistant` | `step`, `text`, `tool_calls: [{call_id, tool, args, args_text?, malformed?}]`, `reasoning?`, `reasoning_opaque?`, `usage?`, `finish?`, `failure?` |
| `hook` | `hook`, `event`, `decision`, `text?`, `args?`, `shown?`, `args_text?`, `calls?`, `keep?`, `wrap?`, `keep_reply?`, `replace_context?`, `call_id?` |
| `tool_result` | `call_id`, `tool`, `ok`, `result` or `error` |
| `interrupt` | `source`, `text`, `step` |
| `harness_changed` | `harness_hash` (§12.3) |
| `run_end` | `reason`: `stop` \| `limit` \| `infra_failure` \| `host_end` \| `harness_end` |

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
wasn't JSON (§14) is logged with `args: {}` and `malformed`: the text as the model sent it. `usage`, `finish`
and `failure` are the model response's (§14), as the host gave them. The `assistant` entry always logs the response
as the model sent it; what hooks made of it (§5.4) is in the `hook` entries that follow.

Entries of a child run (§10) are written inline with `depth` = parent depth + 1 and
`parent_call` = the `call_id` of the `core_spawn` call. Top-level entries carry neither member,
except `run_start`, which always carries `depth`.

Member details: `assistant.text` is `""` when the response has no text, and `tool_calls` is
`[]` when it has no calls. A `hook` entry is written for **every** hook that runs, `allow`
included, in chain order (§5.2); it carries `call_id` on tool events (`pre_check`, `pre_tool`, `post_tool`),
`text` when its decision has one, `args` for a `modify` on `pre_check` or `pre_tool`, `shown` for one on
`pre_check` and `args_text` with `shown: modified` when the argument text differs from the canonical form of
`args` (§5.4), `calls` for a `modify` on `post_response`, and `keep`, `wrap`, `keep_reply` and `replace_context`
when the decision has them (`replace_context` as given, its `text` excerpted unless its `wrap` is `false`). A
`tool_result` carries `result` iff `ok`, else `error`. An optional member is left out, never `null`.
Every line ends with `\n`.

---

## 8. The run loop

1. Log `run_start`. Run `session_start` hooks. Assemble and log `system` (§9.1).
2. Ask the host for the next user message; if the conversation has none left, end with `stop`.
   A message that isn't a string is an infrastructure failure. Run `user_prompt` hooks. If
   denied, go back to 2. Else log `user`: the message, or the text of the chain's last `replace`.
3. **Step.** If `steps_used ≥ max_steps`, end with `limit`.
   1. Top-level run only: take a replacement harness (§12.3), then deliver queued interrupts
      (§11).
   2. Run `pre_request` hooks.
   3. Render the request (§9) and call the model. `steps_used += 1`. Log `assistant`.
   4. Run `post_response` hooks. `end` → end with `harness_end`. `retry` → next step, none of the
      reply's calls run. A response that failed (`failure`, §14) and that no hook retried or ended →
      end with `infra_failure`. Otherwise the reply's calls are those of the chain's last `modify`, or
      all of them.
   5. For each of those calls, **in order**:
      - If `tool_calls_used ≥ max_tool_calls`, end with `limit`.
      - `tool_calls_used += 1`.
      - Unknown tool → `tool_result` with `ok: false` and the `unknown_tool` text as `error`
        (§8.2). No hooks run.
      - Run `pre_check` hooks.
      - A call whose argument text wasn't JSON (`malformed`, §14) and that no `pre_check` hook
        modified → the `malformed_arguments` text; arguments that fail the input schema → the
        `invalid_arguments` text, with the reasons of §8.1. No more hooks run. (The default texts are
        fixed so that every engine and every schema library produces the same tokens.)
      - Run `pre_tool` hooks. If denied → no execution; the deny is the result (§9.3).
      - Execute. Log `tool_result`. Run `post_tool` hooks. `end` → end with `harness_end`.
   6. If there were tool calls → next step.
   7. No tool calls → if this turn has had fewer than `limits.max_continues` `continue`
      decisions, run `stop` hooks; otherwise skip them (the model may stop). If `continue` →
      next step. Otherwise the turn ends: go to 2. The `continue` count resets when a new user
      message is admitted.

A deny never ends the run. Only limits, infrastructure failures, the host, the end of the
conversation, or a hook's `end` do. A one-shot host is a conversation with one user message. The host may end the
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

`tool` is the tool's name as the model called it (or as a `post_response` `modify` renamed it); `args` is the
call's argument text in the harness's form (§9.4) and `args_indented` the same with two-space indentation, as that
form defines it, both of the arguments that were checked: after a `pre_check` `modify` the modified ones, written
as `shown: modified` would show them (§5.4), whatever `shown` says; `reasons` are those of §8.1, joined with `; `,
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
`malformed`), as a `post_response` `modify` and a `pre_check` `modify` with `shown: modified` changed them
(§5.4), and its `reasoning` and `reasoning_opaque` when the entry has them (§7); `usage`, `finish` and `failure`
are not part of the request. An adapter sends a call's argument text (§9.4) where the provider takes the arguments
as text.

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
| `user_prompt` `replace` | the user's message is its text (the `user` entry), without the wrapper |
| `post_response` `modify` | the assistant message carries the listed calls, in that order, under their names; their tool messages follow in that order; a call left out has none |
| `post_response` `retry` | without `keep_reply` the reply's assistant message is gone; a `replace_context` in it replaces the messages before the reply as that decision does, its wrapper with `decision="replace_context"`; its `text` is a user-role message after them: the wrapper, or with `wrap: false` the text itself, alone |
| `pre_check` `modify` | with `shown: modified`, the call carries the modified arguments and their text; with `shown: model`, nothing changes |
| `allow`, `failed`, `end`, a `deny` on `user_prompt` or `interrupt` | nothing |

When several decisions concern one call, its tool message is built from its log entries in log
order: each `modify` adds its wrapper and `"\n"`; then comes the body, which is the `deny`
wrapper if a hook denied the call, else the wrapper of the last `replace`, else the result; then
each `add_context` adds `"\n\n"` + wrapper. The tool messages follow their assistant message in
call order; a call that never finished (the run ended first) has none. The `add_context`
decisions of a denied user message or interrupt are dropped with it.

Several user-role contributions in a row are **merged** into one user message, joined by
`"\n\n"`, in log order; the user's own messages count as contributions. The messages a
`replace_context` keeps stay as they were: the first of them doesn't merge into the replacing message. The
unwrapped text of a `retry` (`wrap: false`) is a message of its own: it doesn't merge into the message before it,
and nothing merges into it.
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

So a harness names the form of its argument text, `argument_text`, and there are exactly three. Each
reproduces what one real harness sends byte for byte and is in the spec because a recorded harness needed it:

| `argument_text` | Writes what this writes | Needed by |
|---|---|---|
| `model_order` (default) | ECMAScript: `JSON.stringify(JSON.parse(text))` | pi 1.5.2 (TypeScript), Mouseion's first rebuild: 18 recordings replay byte for byte |
| `sorted_ascii` | Python: `json.dumps(json.loads(text), separators=(",", ":"), sort_keys=True)` | Hermes Agent 0.22.6 (Python), Mouseion's second rebuild: its source writes arguments so (`_canonicalize_tool_call_arguments`), and a recorded Terminal-Bench trial shows them sorted |
| `as_sent` | nothing: `text` itself, as the model sent it | mini-swe-agent 2.4.6 (Python, LiteLLM), Mouseion's fourth rebuild: LiteLLM keeps the provider's `arguments` string and sends it back unchanged; in Mouseion's first recording run all 11,536 earlier calls went back in the spaced form KIT's model wrote (`{"command": "…"}`) |

The set is closed. `argument_text` is not a formatting option to tune: each value names what a real harness
sends, and an engine that implements it writes exactly those bytes. A fourth form is added only by a change of this
spec, backed by a recorded harness that needs it, and defined here as exactly as these three.

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

**`as_sent`.** `text` as it is: the response call's `raw`, byte for byte, spaces, member order, escapes and number
forms included; a call without `raw` gets its `model_order` text. With two-space indentation (`{args_indented}`) it
is `model_order`'s.

**Repaired arguments.** A `pre_check` `modify` with `shown: modified` (§5.4) gives a call a new argument text, which
wins over the model's in every form: the hook's `args_text`, else the modified arguments written in the harness's
form as for a call without `raw` (with `as_sent`, `model_order`'s text).

The argument text is written when the call is logged, in the form of the harness that runs the call: a
child's own (§10); after a reload, the new harness's for new calls, while the calls already logged keep
theirs (§12.3). The log keeps it as `args_text` when it differs from the canonical form of `args` (§7), and
the request carries it the same way: a call's argument text is its `args_text`, else the canonical form of
its `args`. So a log replays without the model's text. A call whose text wasn't JSON goes back as `{}` (its
`args`) in either form: a provider that reads the arguments of earlier calls would reject the broken text,
and the error tells the model (§8.2).

**Known differences.** Where an original does more around its serializer, Fausth doesn't follow, and a
rebuild's replay differs from the recording there:
- Hermes repairs arguments it can't parse (`_repair_tool_call_arguments`) and sends the repaired text back. Since
  0.7 a `pre_check` hook can do the same (§5.4); without one, Fausth sends `{}` and the `malformed_arguments` text
  (§8.2).
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
n}`, with the requests and calls counted against the child. A child that ends with `stop`, `limit`
or `harness_end` returns this result; a child that ends with `infra_failure` or `host_end` ends the whole
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

`run_end.reason`: `stop`, `limit`, `infra_failure`, `host_end`, `harness_end`. Infrastructure failures
(model API errors, a failed response no hook answered, unreachable tools or handlers, failed hooks) are never
scored as model behaviour. `limit` is the engine's own count and replays exactly; `host_end` is the host's
decision (its user left, `timeout_ms` passed) and happens in replay only where a recording says so (§14);
`harness_end` is the harness's decision, a hook's `end` (§5.4), and replays exactly, so a log tells a run its
harness ended (mini-swe-agent's submit) from one its host stopped.

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
- **A handed harness that can't run is not launched.** The binding fills its host values first (§2.1), with
  the launching host's. One whose values can't be filled, that isn't valid (§2, §3, §5.1), or that declares
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
- **Failures.** A launched run that ends with `stop`, `limit` or `harness_end` gives the binding what the
  binding makes of it. One that ends with `infra_failure` or `host_end`, or a task that isn't a string, leaves the binding
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
| `model.jsonl` | `{text?, tool_calls?: [call], reasoning?, reasoning_opaque?, usage?, finish?, failure?}` | the next response; `text` defaults to `""`, `tool_calls` to `[]` |
| | `{error}` | the model API failed: no response, an infrastructure failure |
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
it, and `usage` (an object) the token counts the provider reported (§5.3). `finish` (a string) is why the response
ended, as the provider said it (Chat Completions' `finish_reason`: `stop`, `length`, `tool_calls`, …). `failure` (a
string) says that the response failed, in the host's words: the provider rejected the request, or the answer broke
off; the response then holds what arrived before (often nothing), and it is the `post_response` hooks' to answer
(§8). A host decides which failures it hands over this way, for a harness that handles them (OpenCode compacts after
a context overflow), and which it retries itself or reports as `error`. A host's model response has the
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
compacts like pi this way (its handler's binding holds pi's trigger, cut and summary requests). A reply cut off at
its output limit (`finish: length`) can be answered the same way after the fact: a `post_response` hook returns
`retry` with a `replace_context`, and the model is asked again with the compacted conversation (pi's
compact-and-retry).

**A.4 Completion gate.** A `stop` hook runs `core_last_result {tool: tests_run, path: exit_code,
eq: 0}`. If the tests didn't pass, the failed check becomes `continue` (§6). If the model can't
fix them, `limits.max_continues` (default 3) lets it stop after three rounds instead of looping
until `max_steps`.

**A.5 Self-refinement.** Flexible tools such as `call_proto_tool {name, args}` and
`write_tool {name, code}`, plus a harness file the host re-reads (§12.3).

**A.6 Code-only agent (Prime Agent style).** `tools: {python_exec: …}` and nothing else.

**A.7 A title after the turn.** Hermes Agent 0.22.6 names a session once its turn is over, with a request
of its own: the title prompt as system prompt, the opening user message (wrappers such as
`<system-reminder>` stripped, cut to 1000 characters) as the only user message, no tools, not streamed,
`reasoning_effort: "none"`, a JSON `response_format`. The title never enters the conversation. One file per
agent:

```yaml
# title.yaml: the title agent
spec: harness/0.7
name: session-title
prompt: |
  You name chat sessions. Given the user's opening message, write a title of 3 to 7 words.

  Reply with JSON only: {"title": "..."}
handlers:
  save_title:
    description: Reads the title from the reply and stores it for the environment.
hooks:
  - id: save
    on: stop
    run: save_title
limits: { max_steps: 1, max_tool_calls: 0, max_continues: 1 }
```

```yaml
# main.yaml: the agent (its tools, prompt and other hooks left out)
handlers:
  make_title:
    description: Launches the harness it is handed on the opening user message (§13.1).
hooks:
  # stop hooks that may continue come first: a continue ends the chain (§5.2)
  - id: title
    on: stop
    run: make_title
    on_failure: skip          # a title is advice, not a rule
    with:
      harness: <title.yaml>   # the whole file, inlined by the authoring tool (§2)
      max_chars: 1000
```

The deployment binds `make_title` to a launched run (§13.1): its task is the first user message in the hook
input's `context`, wrappers stripped and cut to `with.max_chars`; its answer is `allow`; and once the
environment has a title it answers `allow` without launching. In the title run, the `stop` hook hands the
reply (`message`) to `save_title`, which stores the title for the environment and answers `allow`, so the
title run's request stays tool-free, as Hermes's is; its deployment sends that request not streamed, with
`reasoning_effort: "none"` and Hermes's `response_format`. The main run's log records only the `allow`; the
title run's log is its own, and its `run_start` carries the hash of `title.yaml`, which the main file's hash
covers. Since the answer doesn't depend on the title, a host MAY run it in the background, as Hermes does. A
turn that has used up `max_continues` skips its `stop` hooks (§8), so it makes no title; the next turn does.
The fixtures `v06-stop-context` (the main run, with `max_chars: 40`) and `v06-stop-title-run` (the title run)
are such a pair; both engines' tests run the two together with the binding live (`harness_binding` in
`fausth.launch`, `harnessBinding` in `launch.ts`).

*Or the main model writes the title.* That works without a launched run, next to the completion gate (A.4): a
model-facing tool `write_title {title}`, and a `stop` hook `core_called_since {tool: write_title}`, whose
failed check becomes `continue` with `write_title not called yet` (a handler that checks the `view` can word
its own reminder). The title then costs the main conversation a step and the model sees the reminder;
Hermes's title never enters the conversation.

**A.8 A format check on every reply (mini-swe-agent 2.4.6).** mini-swe-agent answers a reply that has no valid
`bash` call with a plain user message and asks again, ends its run at the third such reply in a row, sends the task
inside a template, and ends the run when a command prints its submit line:

```yaml
spec: harness/0.7
name: mini-swe-agent
prompt: You are a helpful assistant that can interact with a computer.
argument_text: as_sent                 # LiteLLM sends the model's own text back
tools:
  bash: { description: Execute a bash command, input: { type: object, properties: { command: { type: string } }, required: [command] } }
handlers:
  mini_instance: { description: Fills instance_template with the task and the machine; answers replace. }
  mini_format_check: { description: "Checks a reply's calls: allow, retry with the error (wrap false), or end at the third in a row." }
  mini_submit: { description: Answers end when the output's first line is the submit line and the command exited 0. }
hooks:
  - { id: instance, on: user_prompt, run: mini_instance, with: { instance_template: "Please solve this issue: {{task}} …" } }
  - { id: format_error, on: post_response, run: mini_format_check, with: { format_error_template: "…", max_consecutive: 3 } }
  - { id: submitted, on: post_tool, match: bash, run: mini_submit, with: { line: COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT } }
```

The handlers are the host's code (mini's templates are Jinja); the file holds every text the model reads. The log
shows each dropped reply with its `retry` and the error text, and a submitted run ends with `harness_end`.

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

**Resolved 2026-11-25, before 0.6 was tagged (the user, for requests after the model's last reply):** real
harnesses send requests after the last reply: Hermes Agent 0.22.6 a title request once the turn is over,
pi 1.5.2 possibly a compaction summary (open point 2), and no `stop` handler could build either.
- `raw`, the model's own argument text on a response call (§14), is accepted as built.
- The `stop` hook input carries `context` and `usage`, exactly as `pre_request`'s (§5.3). `stop` keeps its
  decisions (`continue`, `add_context`); `replace_context` on `stop` is still not adopted (open point 2).
- Side requests are other Fausth runs, launched by the environment, not by the engine. In the user's words:
  "we allow a tool call that in the environment can launch another Fausth agent with its own harness". A
  tool or handler can be bound to another run with its own harness, log and limits (§13.1). The engine gains
  no `spawn` decision and §8 doesn't change; `core_spawn` stays as it is (§10 contrasts the two). The
  launched run inherits no hooks: the author wrote it, not the model, so the safety reason for §10's
  inheritance doesn't apply, and a `stop` hook's title run would otherwise ask for a title of itself.
- One file per agent, and all of a system's harnesses in one place. In the user's words: "a single file per
  agent helps us better see and compare agents' behaviours". So the binding runs the harness it is handed by
  the caller, not one fixed in the deployment: a handler's from its hook's `with`, so the calling file names
  its sub-agent and includes its file (the resolved harness and its hash hold them all, §2); a tool's from
  its arguments, so an orchestrator's model can write a sub-agent at runtime (§13.1).

**Resolved 2026-11-26 (the user, after Mouseion's first review round: pi 1.5.2, Hermes Agent 0.22.6, OpenCode
2.2.7, mini-swe-agent 2.4.6; `docs/gaps.md` and each entry's `SPEC-DIFF.md` there):** four changes, chosen as the
most pressing of the round, as the spec diffs proposed them.
- A hook on the model's reply, `post_response` (Hermes D3, mini-swe-agent M1 and M2, OpenCode O5, pi's
  compact-and-retry, open point 3 below): `modify` the calls, `retry` (with `text`, `wrap`, `keep_reply` and a
  `replace_context`), `end`; `end` also on `post_tool`; the run end `harness_end` (§4, §5.4, §8, §12.2). The
  response gains `finish` and `failure` (§14).
- Argument repair before the schema check, `pre_check` with `modify` and `shown` (Hermes D2, OpenCode O2, pi's gap
  4, which 0.6 left out).
- A third argument text, `as_sent` (mini-swe-agent M3), backed by its first recording run.
- Host values: `user_prompt` `replace` (mini-swe-agent M4) and `${NAME}` with a fixed set of standard names
  (Hermes D6, OpenCode O7, pi's gap 6, which 0.6 left to an authoring step), filled at load (§2.1).

Where the proposals left a choice open, 0.7 took the simplest that covers every harness cited; the CHANGELOG
(0.7.0, "Choices for the user") lists each. The rest of the round waits for review 2: compaction shapes beyond
`keep` and `wrap` (Hermes D4), tool-name aliases (OpenCode O1), a standard include (Hermes D7, OpenCode O7, open
point 5), no schema check (`check_arguments: none`, Hermes D1, mini-swe-agent M5), JSON-escaped engine texts and
the host's text for every engine failure (OpenCode O3), `wrap: false` on `add_context` and `continue` (OpenCode
O4), the system prompt and tools in the `pre_request` input (OpenCode O6), and calls left out of later requests
(Hermes D8).

**Still open:**
1. **Images and other non-text results:** planned for a later version, after more host runs.
   Needs a fixed adapter rule for providers that don't accept images in tool results.
2. **A check after the last reply.** pi checks the context again after a run's last reply and may
   compact then. Since 0.6 a `stop` handler gets `context` and `usage` (§5.3), so it can measure as pi does
   and send pi's summary request through a launched run (§13.1); but `stop` allows only `continue` and
   `add_context`, so the summary can't replace the context (the user's decision, 2026-11-25). In a one-shot
   run this changes nothing the model sees (no one reads that summary). In a conversation the next request's
   `pre_request` hook can compact instead, but by then the context holds the next user message, which pi's
   summary leaves out, so trigger and cut can differ. Proposal, not adopted: `stop` also allows
   `replace_context`.
3. *Resolved in 0.7:* **asking again after compacting.** pi drops a reply cut off below its token limit,
   compacts and asks again: a `post_response` `retry` with a `replace_context` (§5.4, Appendix A.3).
4. **Validators' own messages.** Identical texts for invalid arguments need the original's validator
   messages (pi-schema's); a host supplies them (§8.1). No general rule for them is planned.
5. **A standard include syntax.** §2 leaves includes to authoring tools, so two tools may resolve the same
   files differently. With sub-agents included in a hook's `with` (§13.1), whether one include syntax should
   be standardised, so that every engine resolves a system's files to the same document and hash, is open.
6. **A launched run from a model-facing tool.** When a tool's binding launches the harness the model wrote
   (§13.1), no narrowing check and no inherited hook applies: the run reaches what its deployment binds. The
   reason for not inheriting (the author wrote it, not the model) holds for a handler's sub-agent; whether a
   tool's should be narrowed like `core_spawn`'s child is open.
