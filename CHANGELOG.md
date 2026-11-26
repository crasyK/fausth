# Changelog

## 0.7.0 — 2026-11-26 (not tagged)

Spec v0.7 (`docs/spec-v0.7.md`; v0.6 moves to `docs/archive/specs/` with its schema). Four changes, the user's
decision of 2026-11-26 after Mouseion's first review round (decision 10 in Mouseion's `docs/plan-automation.md`
§4): its rebuilds of pi 1.5.2, Hermes Agent 0.22.6, OpenCode 2.2.7 and mini-swe-agent 2.4.6 each recorded what
Fausth would need as a spec diff, and these four were the most pressing. The rest of the round (compaction shapes,
aliases, `$include`, `check_arguments: none`, JSON-escaped texts, `wrap: false` on `add_context`, the system prompt in
the hook input, calls left out of later requests) waits for review 2 (spec Appendix B).

### Moving a file from 0.6 to 0.7
- **In the file:** change `spec: harness/0.6` to `spec: harness/0.7`. Nothing else is required.
- **Placeholders:** a host now fills `${NAME}` in `prompt` and in tool descriptions when it loads the file
  (`fill_host_values` / `fillHostValues`, §2.1). A file whose prompt or tool descriptions hold a literal `${NAME}`
  (an uppercase name; a shell snippet, say) writes it `$${NAME}`; one that holds `${if …}` or `${end}` likewise. A
  host that filled its own placeholders before the engine (Mouseion's loaders) declares the names it uses beyond the
  standard ones in `host_values` and passes the values to the fill. Standard names have fixed formats (`DATE` is
  `YYYY-MM-DD`); a file that wrote another date under `${DATE}` renames its own.
- **What may change in the tokens:** nothing, for a file that uses none of the new members: every 0.6 decision renders
  as before. `harness_hash` changes for every file (the spec value; and since the hash covers the filled harness,
  for a file with placeholders it now differs between runs whose values differ).
- **Hosts and log readers:** a model response may carry `finish` and `failure` (§14); the Chat Completions adapters
  set `finish` from `finish_reason`, so logs made through them gain `finish` (requests don't change).
  `run_end.reason` may be `harness_end`. A hook entry may carry `shown`, `args_text`, `calls`, `keep_reply` and
  `replace_context`.

### Spec
- **A hook on the model's reply, `post_response`** (§4, §5.3, §5.4, §8 step 3.4). After every response's `assistant`
  entry, before any call runs. Input: `reply` (the entry's text, calls with the model's `raw` text, reasoning,
  `finish`, `failure`), `context` (the request the reply answers) and `usage`. Decisions: `modify` with `calls`
  (`{call_id, tool}`: the calls that run, in that order, under those names; later requests show the reply so),
  `retry` (none of the calls runs and the model is asked again, a new step: optional `text` as a user message,
  `wrap: false` making it a message of its own, `keep_reply` keeping the reply, and a `replace_context` in that
  decision's shape applied to the conversation the reply answered), `end` (the run ends with `harness_end`). `end`
  is also a `post_tool` decision: the reply's later calls don't run. The response gains `finish` and `failure`; a
  failed response no hook retried or ended is an infrastructure failure (§12.2, §14). `run_end.reason`
  `harness_end`: a child that ends so returns its result, a launched run's binding gets its answer (§10, §13.1).
  Sources: Hermes D3, mini-swe-agent M1 and M2, OpenCode O5, pi's compact-and-retry (0.6 Appendix B, point 3).
- **Argument repair before the schema check, `pre_check`** (§4, §5.4, §8 step 3.5, §9.4). Match: tool ids. Input: the
  call with `args`, the model's `raw` text and `malformed` (until a hook modified it). Decision `modify` with `args`
  and `shown`: `model` (later requests show the model's text; OpenCode) or `modified` (the repaired arguments and their
  text, the hook's `args_text` that must read as `args`, or the harness's form; Hermes). The modified call is then
  checked as any call; the texts' `{args}` show the checked arguments. The log keeps both. Sources: Hermes D2,
  OpenCode O2, pi's gap 4.
- **A third argument text, `as_sent`** (§9.4): the response call's `raw`, byte for byte; a call without `raw` gets the
  `model_order` text; a text that isn't JSON still goes back as `{}`; `{args_indented}` is `model_order`'s. A
  `pre_check` repair with `shown: modified` wins. Backed by mini-swe-agent's recording run 1 (all 11,536 earlier calls
  went back in KIT's spaced form). Source: mini-swe-agent M3.
- **Host values** (§2.1, §5.4). `user_prompt` `replace`: the admitted message is the hook's text, unwrapped and whole
  (mini-swe-agent M4). `${NAME}` placeholders in `prompt` and tool descriptions, filled at load from a map of
  strings: eight standard names (`CWD`, `HOME`, `DATE`, `YEAR`, `TIMEZONE`, `OS`, `MODEL`, `PROVIDER`, each with an
  exact form) and the names the file declares in `host_values`; slots (a paragraph that is only a placeholder
  vanishes when empty) and `${if NAME}` … `${end}` blocks; `$${` writes `${`; values are not read again; an undeclared
  or unsupplied name is a load error. A launched run's harness is filled at launch with the launching host's values;
  a `core_spawn` child's is not. Sources: Hermes D6, OpenCode O7, pi's gap 6.
- Appendix A.3 (compact-and-retry) and a new A.8 (mini-swe-agent's format check); Appendix B logs the decision and
  marks open point 3 resolved.

### Choices for the user
Where the proposals left a choice open, 0.7 took the simplest that covers every harness cited. Each can be overturned:
1. **`post_response` runs before `stop`,** on every response, with or without calls. A `modify` that removes every
   call makes a reply without calls: the turn goes to `stop` hooks (§8 step 7), it is not a `retry`.
2. **`modify`'s `calls` name calls, they don't make them:** `{call_id, tool}` only, each a call of the reply (once);
   no new calls and no new arguments (`pre_check` changes arguments). Later requests show the modified calls (what
   Hermes does with repaired names and removed duplicates).
3. **`context` on `post_response` is the request the reply answered,** the reply being `reply`; `keep` in a retry's
   `replace_context` counts those messages. `reply`'s calls carry the model's `raw` text, which the log doesn't
   keep: the one hook-input member not derived from the log (replay has it in `model.jsonl`).
4. **`finish` and `failure` are new response members, both logged** in the `assistant` entry. `{error}` stays the
   model API's failure (no response). A host decides which failures it hands over as `failure`.
5. **A `retry` applies, in order:** drop the reply (unless `keep_reply`), the `replace_context`, the kept reply, the
   `text`. The replacement's wrapper says `decision="replace_context"`, the text's `decision="retry"`.
6. **An unwrapped retry text merges with neither neighbour;** a wrapped one merges like `continue`'s.
7. **No retry limit** beyond `max_steps` (a handler counts its own, as mini-swe-agent's does).
8. **`end`'s `text` is logged, not shown.** `harness_end` in a child or a launched run counts as an ordinary end (like
   `stop`).
9. **`pre_check` runs after the unknown-tool check** (known tools only, as `match` names tools) and before the
   malformed and schema checks; it allows only `modify`; `shown` is required; the repaired `args` are not checked when
   the hook decides (the schema check after it is the check). When several hooks modify, the last one's `shown`
   holds.
10. **The engine's texts show the checked (repaired) arguments** in `{args}` and `{args_indented}`, whatever `shown`
    says (OpenCode's validator prints the repaired arguments).
11. **No built-ins on `post_response` and `pre_check`** (a validation error).
12. **`user_prompt` `replace` chains** (the next hook's `message` is the replacing text) and is not excerpted; both
    the `hook` entry and the `user` entry carry the text, so the host's original message is not in the log.
13. **Host values are filled at load, so the hash covers the values** (the resolved harness, §2), and the `system`
    entry logs the filled prompt. The alternative, values logged in `run_start` and filled at render, keeps one hash
    per file but needs more engine code.
14. **The standard names' forms are neutral, not any one harness's:** `DATE` `YYYY-MM-DD`, `TIMEZONE`
    `UTC±HH:MM`, `OS` as `uname -s`, `CWD` with `/`. Hermes's long date and OpenCode's `toDateString` date are their
    own declared names; Hermes's zone line is `(${ZONE_NAME}, ${TIMEZONE})`. `host_values` is a list of names (no
    descriptions).
15. **Filled are `prompt` and tool `description`s only** (not `texts`, `with`, handler descriptions). Sub-agent prompts:
    a launched run's harness is filled at launch (`harness_binding(…, values=…)`); a `core_spawn` child's is the
    model's text and is not filled.
16. **Slots and blocks follow Hermes's loader exactly** (`\n\n` before, `\n\n` or the end after; the shortest body),
    with `$${` as the one escape; a stray `${if …}` or `${end}` is a load error.
17. **The Chat Completions adapters map `finish_reason` to `finish`.**

### Engines
- Python, TypeScript and Rust: the run loop's `post_response` and `pre_check` chains, `post_tool` `end`,
  `harness_end`, `user_prompt` `replace`, `as_sent`, `finish` and `failure` in the response check and the log;
  the renderer applies `post_response` `modify`/`retry` and `pre_check` `modify` and never merges an unwrapped retry
  text; the view sees renamed calls and repaired arguments. `fill_host_values` (Python, Rust) / `fillHostValues`
  (TypeScript); `harness_binding` takes `values` (Python, TypeScript `values` option, Rust `LaunchOptions.values`).
  Rust's `Map` gains `get_str`. Schema `schema/harness.v0.7.json` (the new events, `as_sent`, `host_values`).
- Tests: the host-value vectors in each engine, launch with values, `finish` and `failure` types; all three engines
  replay all 71 fixtures byte for byte (Python 426 tests, TypeScript 394, Rust 28, whose conformance tests cover
  every vector and fixture; `cargo fmt` clean;
  the browser host's typecheck and tests pass).

### Conformance
- Every harness and fixture declares `harness/0.7` (expected files changed only in `harness_hash`);
  `invalid/spec-0.6.yaml` is new, `invalid/spec-0.7.yaml` became `spec-0.8.yaml`.
- Ten new fixtures: `v07-post-response-modify`, `v07-post-response-retry`, `v07-post-response-end`,
  `v07-post-response-failure`, `v07-post-tool-end`, `v07-child-harness-end`, `v07-pre-check`,
  `v07-pre-check-sorted-ascii`, `v07-argument-text-as-sent`, `v07-user-prompt-replace` (conformance/README says what
  each shows). `host-values.json` (27 cases). Harness vectors for the new events, `as_sent` and `host_values`
  (3 valid, 11 invalid). `openai.json`: `finish`.

### Checked against Mouseion (port check)
In a copy of Mouseion (its own files untouched), the four entries were ported to 0.7, moving into their files what
the four changes replace, and `python3 tools/verify.py` gave **51 of 51 recordings as expected**, its table identical
row for row (tokens, same-bytes counts, wire) to the run on 0.6.1:
- **mini-swe-agent:** the task template (`user_prompt` `replace`), format errors (`post_response` `retry`, `wrap:
  false`; the third in a row `end`), submit (`post_tool` `end`, `harness_end`), `argument_text: as_sent` (the wire
  takes the engine's text). Its five synthetic recordings (format errors, three in a row, the submit) also replay
  identical.
- **Hermes:** its prompt's placeholders, slots and blocks are spec 0.7's (`loader.py` supplies values); its reply check
  is the `post_response` hook `reply_check` (`modify`, `retry`, `end`), the adapter no longer leaving duplicates out.
  Its static check passes (five prompt variants filled byte-identical).
- **OpenCode:** host values filled by the engine (also websearch's description); OpenCode's argument repair is the
  `pre_check` hook `repair` (a port of `tool-input-repair.ts`, `shown: model`), exercised by its driver scenarios s1
  and s2, which stay identical.
- **pi:** `${CWD}` and `${PKG}` filled by the engine; the check after each reply is the `post_response` hook
  `after_answer`, whose compact-and-retry (never reached in a recording) is now a `retry` with a `replace_context`.

## 0.6.1 — 2026-11-25

A third engine, in Rust (`engines/rs/`), for spec v0.6. No change to the spec, the files or the other two engines:
a 0.6.0 file runs unchanged and logs the same bytes. Released at the user's decision (2026-11-25). It exists so that
Mouseion can give a Rust harness (Codex first) a runner in its own language.

- **Conformance:** every vector in `conformance/` and all 61 fixtures replayed byte for byte (the log and the
  rendered requests), including the launch pair of §13.1 with the binding live. `cargo test`, and `fausth replay
  <fixture dirs>` from the command line (silent when identical; prints what differs and exits 1).
- **CI:** a `rs` job (format check, tests, replay of every fixture).
- **Scope:** the engine, the Chat Completions mapping (`to_chat`, `from_chat`, with `reasoning_replay`), the replay
  host and `harness_binding` (§13.1). No HTTP transport: the host makes the calls. Details in `engines/rs/README.md`.

### Found while building it (spec points, for the user's next spec review; no change made)
- **`multipleOf` on doubles** (§3.2 says "standard semantics", which doesn't settle it): Ajv and Python's
  `jsonschema` test whether the quotient of the two doubles is an integer, and the Rust engine does the same, but for
  quotients of 10²¹ and more the TypeScript and Python engines disagree with each other (Ajv's `q === parseInt(q)`
  fails there; Python uses `x % d` for an integer divisor). The Rust engine passes an integral quotient.
- **Which patterns are valid:** ECMA-262 is the stated dialect, but each engine accepts some patterns ECMA-262
  rejects and rejects some it accepts: Python accepts `\-` and `\A` and rejects `[]` and `[^]`, which TypeScript
  accepts; Rust accepts `\-`, `\z`, `\A` and `(?i)`. A harness using only plain ECMA-262 patterns is unaffected.

## 0.6.0 — 2026-11-25

Spec v0.6 (`docs/spec-v0.6.md`; v0.5 moves to `docs/archive/specs/`). Nine changes, the user's decisions of
2026-11-25. Five came from Mouseion's rebuild of the pi coding agent (pi 1.5.2) as a Fausth harness, replayed
against recordings of the original; each closes one of the gaps in Mouseion's `harnesses/pi/1.5.2/NOTES.md` that the
rebuild had to work around on the host's side: tool order (gap 1), call ids (gap 2), argument text (gap 3), the
engine's texts (gap 5) and compaction (gap 7). Gaps 4 (pi repairs arguments before checking them) and 6 (host values
in the prompt) get no spec change. Four came before the tag, for Mouseion's second rebuild, Hermes Agent 0.22.6: the
argument text has exactly two defined forms, chosen per harness; 0.6 drops 0.5's files; and for the requests real
harnesses send after the model's last reply (Hermes's session title, pi's check after the last reply), the `stop` hook
input carries `context` and `usage`, and a tool or handler can be bound to another Fausth run that the environment
launches with the harness it is handed.

**Versions.** Until the user declares the spec stable, each version may break files of the previous one, and an
engine runs only files of its own version: a 0.6 engine runs `spec: harness/0.6` and rejects `harness/0.5`.
Backwards compatibility starts once the spec is declared stable. (The user, 2026-11-25: compatibility can still
break upwards each version; when the spec needs no more changes for now, backwards compatibility starts.)
harness-lab pins `v0.5.6`, so it is unaffected until it moves its pin; Mouseion's pi rebuild moves with 0.6.

### Moving a file from 0.5 to 0.6
- **In the file:** change `spec: harness/0.5` to `spec: harness/0.6`. Nothing else is required; `texts` and
  `argument_text` are optional (without them a file gets 0.5's texts and arguments written in the model's order).
  Put `tools` in the order the model should see them, since 0.6 offers them as declared. A `pre_request` handler
  whose `input` schema closes the hook input or its messages must now allow `usage` and the messages' `reasoning`
  and `reasoning_opaque` (fixture `hook-context-rejects-reasoning` shows such a handler failing).
- **What may change in the tokens:** the tools come in the file's order instead of sorted; the provider's tool-call
  ids go back instead of `c<seq>-<i>`; earlier calls' arguments go back in the model's member order instead of
  sorted (`args_text`); a call whose arguments aren't JSON goes back as `{}` and is answered with the
  `malformed_arguments` text (0.5 logged the text as its arguments, which then failed the schema). The default texts
  are 0.5's, so without `texts` the error texts don't change, unless the host gives its own validator's reasons
  (`reasons`, §8.1), which 0.5 ignored. `harness_hash` changes for every file: it covers the
  `spec` value and, now, the tool order.

### Spec
- **Tools in the order the file declares them** (§9). Member order (§1): the order in the document, except that
  ids that are array indexes (`2`, `10`) come first, as ECMAScript orders an object's keys, so TypeScript's plain
  objects and `JSON.parse` keep it. After a live reload the new file's order applies; a child offers its own
  harness's. `harness_hash` = `hash([harness, tool ids in member order])` (§2): two files that differ only in
  their tool order are two harnesses.
- **The provider's tool-call ids are kept** (§7). The model response's `call_id` is the call's id unless it is
  empty, already used in the log, or of the engine's form `c<n>-<n>`; then the engine names it `c<seq>-<i>` as
  before.
- **The argument text, in one of two defined forms** (§9.4, rewritten). The text of a call's arguments that goes
  back to the model is part of what it sees, and real harnesses write it differently. A harness names its form with
  the new top-level member `argument_text`, a closed set of two, each reproducing one real serializer byte for byte
  and traced to the recorded harness that needed it: `model_order` (the default; ECMAScript's
  `JSON.stringify(JSON.parse(text))`, pi 1.5.2) and `sorted_ascii` (Python's `json.dumps(json.loads(text),
  separators=(",", ":"), sort_keys=True)`, Hermes Agent 0.22.6: integers exact, other numbers as `float.__repr__`,
  names sorted by code point, every character outside U+0020–U+007E escaped). A third form needs a spec change backed
  by a recorded harness. The text is written when the call is logged, in the running harness's form; the log and
  the request carry it as `args_text` when it differs from the canonical form of `args`; adapters send it. A model
  response call may carry the model's text as `raw` (§14), which must read as its `args`; `sorted_ascii` needs it
  (a reader that makes doubles has forgotten `1` vs `1.0`). A call whose text isn't JSON is logged with `args: {}`
  and `malformed` (the text) and goes back as `{}`, as pi does. Known differences, not built: Hermes's repair of
  unparseable arguments, Python's `NaN`/`Infinity`, lone surrogates.
- **The engine's texts can be worded in the file** (§8.2): `texts` with `unknown_tool`, `invalid_arguments`,
  `malformed_arguments` (new: an argument text that isn't JSON) and `tool_error` (how any failed result is shown,
  default `{"error":…}`). Templates with checked placeholders: `{tool}`, `{args}` (the argument text in the
  harness's form), `{args_indented}`, `{reasons}`, `{text}`, `{parse_error}`, `{error}`. The defaults are 0.5's
  texts. A host may supply the `{reasons}` text from its own validator (§8.1), which pi's exact wording needs.
- **Compaction** (§5.3, §5.4, §9.3). `replace_context` takes optional `keep` (the newest messages of `context` that
  stay as they are) and `wrap` (`false`: the text is the message as it is, not excerpted to `max_hook_text`). The
  `pre_request` hook input's `context` keeps the logged reasoning, and it gains `usage`, the last response's
  reported token usage (the model response and the `assistant` entry gain `usage`).
- **No 0.5 files** (Status, "Versions"): 0.6 has no section for them; `schema/harness.v0.5.json` moves to
  `docs/archive/specs/`.
- **The `stop` hook input carries `context` and `usage`** (§5.3), exactly as `pre_request`'s: the conversation as it
  would be rendered after the reply without tool calls (logged reasoning and the chain's earlier `add_context`
  included) and that reply's usage. `stop` keeps its decisions; `replace_context` on `stop` is not adopted.
- **A binding that launches another Fausth run** (binding kind `harness`, §13.1). Requests after the model's last
  reply are other Fausth runs, launched by the environment, not by the engine: a tool or handler bound this way runs
  the harness it is handed (a handler's from its hook's `with`, by convention `with.harness`; a tool's from its
  arguments, by convention `harness`) as a separate top-level run, its only user message a task the binding makes
  from its input, with its own log and limits and none of the caller's hooks. A handed harness that isn't valid or
  declares an id its deployment doesn't bind gets `ok: false`, `child harness is not valid` (`core_spawn`'s words); a
  launched run that ends with `infra_failure` or `host_end` is the binding's infrastructure failure. The caller's log
  records only the binding's answer; replay records it in `tools.jsonl`. One file per agent: the calling file
  includes its sub-agents' files in a hook's `with`, so the resolved harness and its `harness_hash` hold a whole
  system (§2). The engine gains no `spawn` decision and §8 is unchanged; §10 contrasts the binding with `core_spawn`.
  Appendix A.7: a session title after the turn, as Hermes makes it, and the alternative with a model-facing
  `write_title` tool and a `stop` gate.
- Appendix B: pi's check after the last reply (`stop` can't replace the context), asking again after compacting,
  validators' own messages, a standard include syntax, and whether a tool's launched run should be narrowed like
  `core_spawn`'s child are open points; a proposal for the first is noted, not adopted. The user's decisions of
  2026-11-25 are logged there, including `raw` accepted as built.

### Engines
- TypeScript and Python: `toolIds`/`tool_ids`, `harnessHash`/`harness_hash`, `argumentText`/`argument_text` (the
  Python one writes ECMAScript's key order and number format), `sortedAsciiText`/`sorted_ascii_text` (TypeScript: a
  reader that keeps number tokens and Python's writer; Python: `json.loads`/`json.dumps`), `fill`, `TEXTS`; the run
  loop keeps provider ids, logs `args_text` in the harness's form, `malformed` and `usage`, checks a call's `raw`,
  words its texts, asks an optional host `reasons(tool, args)`, renders `keep` and `wrap`, and gives `stop` hooks
  `context` and `usage`. Only `harness/0.6` files are valid; the 0.5 code paths are gone. Schema
  `schema/harness.v0.6.json` (with `argument_text`).
- Launched runs (§13.1): Python `fausth.launch` (`harness_binding`, `handed_harness`, `final_text`) and TypeScript
  `launch.ts` (`harnessBinding`, `handedHarness`, `finalText`). `harness_binding(host, task, *, harness, answer,
  binds, on_log)` returns a binding that runs the handed harness on `host` with `task(input)` as its only user
  message and hands the host every launched run's log.

### Adapters
- Chat Completions (`toChat`/`to_chat`, `fromChat`/`from_chat`): calls go back with their argument text; an answer's
  tool-call `id` becomes `call_id`, arguments that are JSON text give `args` and `raw`, arguments that aren't JSON
  become `malformed`, and the body's `usage` object becomes `usage`.

### Conformance
- Every harness and fixture declares `harness/0.6`. The fixtures written for 0.5 were converted; their expected files
  changed only by `harness_hash`, tool order, `args_text` and the spec value inside child harnesses, except
  `hook-context-without-reasoning`, now `hook-context-rejects-reasoning` (its 0.5-style handler fails on 0.6's
  reasoning). `v05-on-0.6`, which tested only the dropped compatibility, is gone; `invalid/spec-0.5` is new.
- New fixtures `v06-tool-order`, `v06-call-ids`, `v06-argument-text`, `v06-argument-text-sorted-ascii`,
  `v06-argument-text-reload`, `v06-texts`, `v06-replace-context-keep`, `v06-hook-context-usage`,
  `infra-model-raw-mismatch`, `v06-stop-context` (a `stop` hook's `context` and `usage`; its title hook hands a
  harness over in `with`) and `v06-stop-title-run` (that harness's launched run, a tool-free request). Both engines'
  launch tests run the last two together with the binding live and get both fixtures' expected files.
- `values.json`: `argument_text` vectors (member order, repeated names, numbers, escapes, indentation) and
  `sorted_ascii` vectors (code-point member order, non-ASCII including astral and DEL, control characters, exact
  integers, floats in Python's edge forms, repeated names). `openai.json`: provider ids, the argument text, `raw`,
  `malformed`, `usage`. Harness cases for `texts`, `argument_text`, `harness/0.5` and `harness/0.7`.

### Checked against pi
- Mouseion's pi 1.5.2 rebuild on 0.6: tool order, call ids and argument text left its `wire.ts` for the engine (pi's
  form is the default, `model_order`), and compaction became a `pre_request` hook (its binding holds pi's trigger,
  cut and summary requests). All 18 recordings replay byte-identical (468 requests, 25 compactions), including
  cobol-modernization__5ewGafh, which differed under 0.5 by gap 5: with pi's texts and pi-schema's reasons from
  the host it is identical now.

## 0.5.6 — 2026-11-10

Invalid arguments now say why. A tool call whose arguments failed the input schema was answered only
`invalid arguments: does not match the input schema`, so a model couldn't tell what to fix. harness-lab found it:
in minimal-plus-v1 Nemotron got that bare answer 59 times in 36 of 450 games, nearly always for an extra member
(`board_try` with a `reason`, `board_move` with a `value`), and after a failed `board_try` it mostly didn't try again.

### Spec
- §8 step 4 and the new §8.1: the error is `invalid arguments: ` followed by reasons built from the schema and the
  arguments by fixed rules, never from a schema library's messages: missing required members, unknown members
  (with the declared ones), then each member's first failing `type`, `enum`, `const`, `minLength`, `maxLength`,
  `pattern`, `minimum`, `exclusiveMinimum`, `maximum`, `exclusiveMaximum`, `minItems` or `maxItems`, joined with
  `; `. JSON Schema still decides validity; when the rules find no reason, the text is the old one.

### Engines
- Python `fausth.schema.argument_reasons`, TypeScript `argumentReasons`, used for invalid tool arguments.

### Conformance
- New fixture `invalid-argument-reasons`. `chess`, `invalid-arguments` and `spawn-denied` carry the new texts.

## 0.5.5 — 2026-10-26

The adapters' default `reasoning_replay` is now `turn`: the reasoning of the current turn's tool loop goes back to
the model, as GLM, DeepSeek and Anthropic ask. The user's decision after harness-lab's reasoning-replay-v1, which found
that sending all earlier reasoning back restored much of GLM's reasoning in one conversation per game, at twice the
tokens. A host that wants the old behaviour passes `none`; `all` stays an explicit choice.

### Spec
- §9: the Chat Completions adapter's default is `turn` (was `none`). Appendix B: the open point is resolved.

### Adapters
- Python `DEFAULT_REASONING_REPLAY` and TypeScript `DEFAULT_REASONING_REPLAY` (`"turn"`): the default of `to_chat` /
  `toChat`, `ChatModel` and the command-line host's `model.reasoning_replay`.

### Conformance
- `openai.json`: `replay.default` (`turn`); with no value, a mapping must equal that case.

## 0.5.4 — 2026-10-20

A fix to 0.5.3. With this, every 0.5.2 harness behaves as before unless an adapter is told to send reasoning back.

### Spec
- The hook input's `context` (`pre_request`) is the request's messages *without* the logged reasoning (§5.3).
  0.5.3 rendered it with the reasoning, so a handler saw a different context than in 0.5.2. A handler whose input
  schema rejected the extra members failed, and one that measured the context (harness-lab's `compact`) would have
  compacted at other points. Reasoning goes only to adapters.

### Conformance
- Fixture `hook-context-without-reasoning`: a `pre_request` handler whose input schema rejects `reasoning` and
  `reasoning_opaque` in the context, over three turns whose model logs both. On 0.5.3 its second hook fails.

## 0.5.3 — 2026-10-20

Logged reasoning can go back to the model. For harness-lab's test of sending GLM's earlier reasoning back
(context-v1 found that in one conversation per game GLM almost stops reasoning). Every 0.5.2 harness stays valid,
and with the default the model sees the same tokens as before.

### Spec
- The neutral request's assistant messages carry the log entry's `reasoning` and `reasoning_opaque` when it has
  them (§9). Before, reasoning was left out, so no adapter could send it back as §9 and Appendix B intended.
- Adapters take `reasoning_replay`: `none` (no logged reasoning goes back), `turn` (that of the assistant
  messages after the request's last user message: the current tool loop, as GLM, DeepSeek and Anthropic expect)
  or `all` (all of it, as GLM's "preserved thinking" and MiniMax recommend). The Chat Completions adapter sends
  `reasoning` as `reasoning_content` and never `reasoning_opaque`. Its default stays `none`, the earlier
  behaviour; the right default is a new open point (Appendix B).

### Adapters
- Python `to_chat(request, model, extra, reasoning_replay="none")` and `ChatModel(..., reasoning_replay=)`;
  TypeScript `toChat(request, model, extra, reasoningReplay)` and `ChatOptions.reasoningReplay`. Any other value
  is an error.
- The command-line host's deployment takes `model.reasoning_replay`.

### Conformance
- `openai.json`: `replay`, one request over two turns mapped with each value, and invalid values.
- The recorded requests of `chess`, `result-rendering` and `tools-only`, whose model logs reasoning, now carry
  it on their assistant messages (nothing else changed).

## 0.5.2 — 2026-10-19

Additions for harness-lab's context-v1 study. Every 0.5.1 harness stays valid and sees the same tokens.
One compatibility note: the hook input has a new member, `turn`, so a handler whose declared `input`
schema closes the hook input's top level (`additionalProperties: false`) now rejects it.

### Spec
- `core_called_since` takes `since: "@turn"`: only calls made in the current turn count, and the failure
  text is `{tool} not called this turn`. A run that spans several user messages (a whole game in one
  context) can now ask "did the model move this turn?", which no tool id could express: after the first
  move, `core_called_since {tool: board_move}` passed for the rest of the run. Needed by harness-lab's
  context-v1 study. `@` can't occur in a tool id, so the value can't clash with one (§5.1, §6, schema).
- The hook input always carries `turn`: the current step at which the run's latest user message was
  admitted (0 before any; interrupts don't start a turn; a child run has its own), the same turn that
  resets the `continue` count (§5.3, §8).

### Conformance
- Fixture `builtin-called-since-turn`: two user messages; a `stop` rule that passes on turn 1 and pushes
  back on turn 2 until the model moves; the list form with `@turn`; a same-response call that doesn't
  count; an interrupt that doesn't start a turn. Harness cases: `@turn` valid; `@turn` as a `tool`, on
  `core_count`, and another `@` value rejected.

### Chess tools
- `turn_brief(..., history="none")` takes `history: none | moves`. With `moves` the brief adds, after the board,
  `Moves so far: 1. e4 e5 2. Nf3` (SAN, numbered, `10... e5` when the list starts on Black's move), or
  `Moves so far: none.`; `board_history` and the brief share one `movetext`. The default leaves every brief as
  it was. Needed by context-v1's arm with the move history. `conformance/chess-tools.json`: 111 vectors.

## 0.5.1 — 2026-10-18

Additions for harness-lab's first harness series (minimal, strategist, squad). Every 0.5.0 harness
stays valid and sees the same tokens.

### Spec
- `core_called_since` takes a list of tools as `tool`: the check passes if any of them has a seen
  successful call after `since`, and the failure text joins the ids with ` or `
  (`board_check or board_piece not called yet`). Needed by the chess strategist harness ("check a move or
  inspect a piece before moving"). A built-in rather than a host handler, so every engine computes it and
  words it the same, and replay recomputes it (§5.1, §6, schema). Files still declare `spec: harness/0.5`;
  a 0.5.0 engine rejects a harness that uses the list.

### Conformance
- Fixture `builtin-called-since-list` (passes through the second tool, fails before any call, resets on
  `since`, a same-response call doesn't count, a one-id list on `stop`); harness cases for the list
  (valid, empty, duplicate, undeclared, non-id, and a list on `core_count`).

### Chess tools
- New tools on both hosts, with the same results: `board_check`, `board_piece`, `board_history`,
  `board_resign`. `board_move` takes `position_hash` as optional.
- For hosts: `move_problem` (the nine move-rule sentences), `render_board` (five formats, two
  orientations) and `turn_brief` (the brief before each move), which harness-lab's `chess_move_rules`
  and `turn_brief` handlers are built on.
- `conformance/chess-tools.json`: 108 python-chess vectors that the chess.js tools reproduce.

## 0.5.0 — 2026-10-17

A rebuild on one small, normative spec: `docs/spec-v0.5.md` (drafted as v0.4), built along
`docs/build-plan-v0.4.md`. Harness files declare `spec: harness/0.5`.

### Spec
- A harness wires tools, hook-only handlers and hooks; the log is the only state; every model request
  is a function of the harness and the log (§0, §9). Seven events, seven decisions, five built-ins
  (`core_called_since`, `core_last_result`, `core_count`, `core_deny`, `core_context`) that pass only on
  results the model had seen (§4–§6). `core_spawn` runs a child harness the model writes, never with
  more than its parent (§10). Interrupts and live reload at step boundaries (§11, §12.3).
- Values in RFC 8785 canonical form, numbers as doubles (§1). Hook decisions reach the model in one
  fixed wrapper (§9.2, §9.3). The provider-neutral request is fixed, so `expected.requests.jsonl`
  tests exactly what a model sees (§9, §14).

### Engines and hosts
- TypeScript (`engines/ts`, about 900 lines) and Python (`engines/py`, about 1,150; its YAML 1.2 reader and
  regex translation make the difference) engines, each with an OpenAI-compatible adapter. Conformance: 46 recorded fixtures, 114 harness examples, value, log and
  adapter vectors; both engines reproduce them byte for byte, and so does the TS engine in a browser.
- Hosts: `python -m fausth run <harness> --deployment <file>` (script, recorded and model bindings,
  python-chess tools) and `hosts/web`, one HTML page with chess.js tools. The spec's §2 chess harness
  played live on both (KIT gateway, OpenRouter).

### Review fixes (before the release)
- Limits are checked with `≥`; with `=`, a live reload that lowered a limit below what was used let the
  run go on unbounded. A reload's `max_steps` applies at once.
- `host_end` is reachable: a host ends the run by raising `HostEnd`; both hosts do so when the harness's
  `timeout_ms` has passed, and a recording asks for it with `{end: true}`. A child's `host_end` ends the
  whole run.
- Malformed user messages and `reasoning_opaque` are infrastructure failures instead of crashes; a harness
  without a canonical form is invalid for every caller; the command line reports unreadable files.
- Seven fixtures for these cases, including a `pre_tool` hook that modifies a `core_spawn` call.

### Retired
- Spec v0.1–v0.3 and the v0.3 documents moved to `docs/archive/`. The v0.3 engines, fixtures, schemas,
  scripts, examples, worlds and case studies are removed; they stay reachable through the
  `v0.4.0-alpha` tag. No compatibility layer.

## 0.4.0-alpha — 2026-10-14 (audit release)

Every finding of the 2026-10-12 audit fixed. Details: `AUDIT-STATUS.md`, `case-studies/CLAIMS-STATUS.md`,
release note `docs/archive/releases/RELEASE-v0.4.0-alpha.md`.

### Contract (spec)
- `docs/spec-v0.3.md` is normative (D1–D16). The validator accepts spec ids v0.1–v0.3 for the one executable IR and
  closes the schema at every level, so a typo can no longer silently drop a rule. Every emitted reason code is specified.
- D8: only executed-and-verified calls count as success. A verify failure discards the call's state transition.
- D6: spawn is denied unless `spawn.allow: true`. Children are charged to the parent.
- D9: checkpoint authority is checked at authorize, and only declared keys are writable.
- D10: recovery goes through the governed path.
- D11: no harness names in the engines. Tools declare `effects` instead.
- D14: the user cell is a host user channel (`channel: user`; recorded / simulator / human); never self-answered.
- Goldens re-derived from the spec, and 29 new `v03-*` fixtures (87 total).

### Engines
- TS: build and `tsc` clean. `bin` runs the current sources. Schemas are cached. Overlays may only narrow.
  Metrics are honest, and boolean CLI flags work.
- Python: a line-by-line port of the v0.3 runtime (`engines/py/fausth/engine.py`). YAML 1.2, standard JSON
  Schema, code-point canonical JSON. Replay is 87/87 byte-identical to TS, and `parity.mjs` + IR fuzz are green.

### Trust boundary
- Signer trust store (`--trusted-keys`, `--require-trusted`) with exit codes 0/1/2/3. Bundle sources are re-resolved
  against the embedded IR.
- Env allowlists for MCP/module children, with cleanup. Bundle-shipped commands need explicit allowance.
- Scopes, protected paths and symlinks are checked on normalized and real paths. All checks run before writes.
- Typed transport errors (infra vs `request_rejected`). Per-call completion ids are recorded (cache-duplicate detection).
- Bundles carry `user.answers.jsonl` (recorded user answers).

### Case studies and scripts
- τ-bench retail world ported faithfully. Safe `calculate` (no `Function()`). The hidden instruction goes only to a
  user simulator. Seeds are deduplicated (−8.5M lines).
- SWE grader follows upstream SWE-bench grading in per-task environments, validated on 25/25 tasks.
  The old Track S "0%" is retracted as an invalid measurement.
- Runner:
  - workspaces contain only the seed;
  - no gold data in prompts or host decisions;
  - pass@1 everywhere, with paired statistics (clustered bootstrap, McNemar);
  - full provenance, and no stale-artifact re-scoring.
- CI runs script tests, recorded matrices, release and evidence checks as independent jobs.

### Models
- KIT defaults: `kit.glm-5.3-flash`, plus `kit.deepseek-v4-flash`. Retired ids fail fast.
  Note: the gateway caches glm responses by request body.

## Unreleased

### Docs hygiene

- Human map: [`docs/README.md`](docs/README.md); examples index; evidence-pack validator (`pnpm evidence:check`).
- Point-in-time `RELEASE-v0.*.md` and superseded `spec-v0.2-draft.md` moved to [`docs/archive/`](docs/archive/).
- CasaOS deploy + in-repo Lab UI removed (live in `/home/mark/fausth-lab`). `live/cache/` and `live/archive/` gitignored.
- Chess extracted to sibling project `/home/mark/chess-harness` (Fausth consumer). Not part of this runtime.

### Mutable cells, module connectors, overlays (M16–M18)

### Added

- Mutable-cell self-editing: `mutable: [skills|memory|instincts]`, `harness.propose_skills_patch`, `harness.decline_skills_patch`, unified `harness.reflect_skills`, `require_prior_any_of`, `rebalance` stage, `fausth select`.
- Track A fixtures: `cb-harness-patch-skills-ok`, `cb-harness-patch-security-denied`, `cb-harness-patch-memory-cautious`, `cb-decline-skills-ok`, `cb-reflect-before-yield-denied`.
- Example: [`examples/mutable-skills/`](examples/mutable-skills/); coding fork [`examples/coding-mutable-skills/`](examples/coding-mutable-skills/) (research/plan baseline-like; implementation reflect-after-tests; host auto-decline).
- Case study: [`case-studies/mutable-cells/`](case-studies/mutable-cells/) (host: `--manifest`); mid-v3 parity Δ = 0 on task_success.
- `kind: module` connectors: offline resolve via `fausth-module-manifest/v0.1` (subprocess execution model; no in-process JS/WASM). Example: [`examples/primitives/module-connectors/`](examples/primitives/module-connectors/).
- Model-adaptive overlays (`overlays` / `resolveOverlay`) — narrow-only tools/limits.
- Docs: [`docs/production-isolation.md`](docs/production-isolation.md) (deferred scope); PROTOCOL P2 expansion section.

### Notes

- Skills patches may only change tool `description` (v0.1 IR). Security/checkpoints remain immutable.
- README still excludes production isolation, universal live completion, and safety beyond case-study bounds.

## 0.3.0-alpha — Output verifies, memory TTL, audit, budgets (M12–M15)

### Added

- Output-surface verifies (`kind: output`) with `verify_output_failed` — predicates on `message.contains_code_fence` / content (Track A).
- Memory provenance map + `invalidate_after.ttl_steps` time-based staleness (mutation `action` rules unchanged).
- `fausth audit` / `fausth-py audit` — deny-log sensor (capability_missing, structured failures, near-misses, output/TTL/budget counters).
- `intervention_budget` + declarative `triggers`; engine emits `budget_exceeded` record events for `window: run`. Host demo: `scripts/intervention-host.mjs`.
- Spec draft / schema: [`docs/spec-v0.3-draft.md`](docs/spec-v0.3-draft.md), [`schema/counterbalance-contract.v0.3.json`](schema/counterbalance-contract.v0.3.json).
- Theory hub drafts: [`docs/notion-hub/`](docs/notion-hub/) (control timing, deny-as-sensor); design doc [`docs/self-improving-harnesses.md`](docs/self-improving-harnesses.md) (mutable cells — implemented in Unreleased/M16).
- Fixtures: `cb-chat-*`, `cb-stale-after-ttl`, `cb-memory-provenance-status`, `cb-budget-exceeded`.

### Notes

- Normative promotion of v0.3 sections rides on Track A fixtures; v0.1/v0.2 goldens remain immutable.
- Unsigned coding `v0.1` pack size pin remains **15411** bytes.
- Mutable-cell self-editing was design-only at the `0.3.0-alpha` cut; see Unreleased.
## 0.2.0-alpha — Normative structured denies (contract v0.2)

### Added

- Normative [`docs/spec-v0.2.md`](docs/spec-v0.2.md) and [`schema/counterbalance-contract.v0.2.json`](schema/counterbalance-contract.v0.2.json).
- Structured deny signal `failure` on Counterbalance denies (`predicate` / `missing_prior_tools` / `checkpoint_key`), with optional checkpoint-derived `unblock`.
- `fs.list` read-only discovery tool; instructive shell allowlist errors.
- Case-study scoring: `discovery_failure`, `obsolete_surface_call`, floor/ceiling headline deltas.
- CLI contract-loop teaching on by default for live coding runs.

### Removed

- In-engine **modes** (`counterbalance.modes`, `mode.enter`, `mode_denied`, orientation `available_modes`).
  Capability limits come only from each harness YAML's tool list. Phased work uses separate
  subagent dirs; host code owns launch order.
- Fixture `cb-write-in-research-mode-denied` → `cb-write-not-provisioned` (`capability_missing`).
- Ad-hoc free-text `hint` on deny events (hosts may still render prose from `failure` for live models).

### Notes

- Normative contract is now **`counterbalance-contract/v0.2`**. v0.1 remains for pre-CB goldens.
- Unsigned coding `v0.1` pack size pin: **15411** bytes.
- Post-cut live baseline gate documented in [`docs/case-studies/PROTOCOL.md`](docs/case-studies/PROTOCOL.md) as `v0.4.0-baseline` (not run in this cut).

## 0.1.3-alpha — Portable connectors, signatures, MCP (M10–M11)

### Added

- Connector manifest + resolved harness IR (`fausth resolve`, `pnpm ci:resolve`).
- Portable resolved bundles: `fausth-harness-bundle/v0.2` (connectors) and `v0.3` (MCP descriptors).
- Optional Ed25519 detached bundle signatures (`fausth pack --sign-key`, `fausth verify`).
- MCP connectors (`kind: mcp`) with offline resolve and host transports `recorded` / `stdio`.
- Live proofs: `scripts/live-mcp-stdio.mjs` (process) and `scripts/live-mcp-model.mjs` (KIT/OpenRouter + MCP).
- Example harness: [`examples/primitives/mcp-connectors/`](examples/primitives/mcp-connectors/).
- Opt-in `limits.continue_after_deny` (default remains terminal deny for Track A goldens).
- Coding case-study live protocol v0.2: held-out grader, single-mode permissive control,
  outcome-based scorer, KIT 80-attempt matrix (`live-kit-v2`).

### Notes

- Legacy coding packs without connectors remain **byte-identical** `v0.1` (17022 bytes unsigned).
- `kind: module` is schema-recognized but fails closed until a later milestone.
- Normative contract remains **`counterbalance-contract/v0.1`**.
- Recorded case-study traces are plumbing regression only; live results are in
  [`examples/coding-counterbalance/VERIFICATION.md`](examples/coding-counterbalance/VERIFICATION.md).

## 0.1.2-alpha — Usable local coding harness (M8)

### Added

- Disposable-worktree-only local adapter (`local.fs_*`, `local.shell`, interactive and `*_auto` checkpoints).
- Path/scope enforcement (`sandbox-path`) rejecting primary checkout, traversal, `.git`, and escaping symlinks/junctions.
- Explicit `deployment.local-*.yml` for coding-counterbalance (never auto-selected by `test` / replay).
- Harness bundle schema `fausth-harness-bundle/v0.1`, safe unpack, and bundle-aware `validate` / `test` / `inspect` / `run`.
- `fausth unpack` (TS + Python) and TS↔Python byte-identical pack (`scripts/bundle-roundtrip.mjs`).
- `fausth run --workspace/--prompt/--task-file/--report/--expect-complete`.
- Track B report fields: `completion_reached`, `e2e_pass_rate` (separate from deny catch rate).
- Disposable worktree bootstrap/cleanup and recorded local e2e (`pnpm ci:local-e2e`).
- Authoring guide: [`docs/authoring.md`](docs/authoring.md).

### Notes

- Normative contract remains **`counterbalance-contract/v0.1`**. Bundle format is `v0.1`. Spec `v0.2` is still a non-normative draft.
- Real KIT/OpenRouter coding e2e in a disposable worktree is nightly/manual and secrets-gated.

## 0.1.1 — Baseline (M0–M7 + polish)

- Dual-runtime Track A conformance, Counterbalance bridge, support-bot world, binding registry, multi-host smoke, live Track B, nested spawn, packaging CLI.
- See [`docs/BASELINE-v0.1.md`](docs/BASELINE-v0.1.md) and tag `v0.1.1-baseline`.
