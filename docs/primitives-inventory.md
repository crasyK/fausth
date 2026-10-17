# Harness primitives inventory (draft, discussion only)

**Status:** Working draft, 2026-10-16. Not normative and not a plan of record.
**Purpose:** Find the small set of primitives a Fausth harness file needs, by looking at what
today's harnesses let you configure.

**Framing (decided 2026-10-16):**
- Fausth is a normal harness. It has the same building blocks as Claude Code, Codex or pi, and
  defines them in one file that can be swapped at run time and does not depend on the
  environment it runs in.
- The file guarantees the same **interface** on every host: prompt, tool ids, schemas and
  descriptions, hook events, and how hook decisions reach the model. It does not guarantee the
  same behaviour. Hosts implement tools however they like.
- The file only wires things together. All logic lives in tools, and a tool can be a script, a
  model, an MCP server or a human.
- Counterbalance is a way to design harnesses, not part of the format.

**Sources and confidence**

| Harness | Source | Confidence |
|---|---|---|
| Claude Code | Official hooks reference ([code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks)), fetched 2026-10-16. Everything else from prior knowledge. | Hooks high; rest medium |
| Codex | Official hooks page ([learn.chatgpt.com/docs/hooks](https://learn.chatgpt.com/docs/hooks.md), redirected from developers.openai.com/codex/hooks). Skills, subagents and config from third-party write-ups ([Vaughan 2026](https://codex.danielvaughan.com/2026/04/12/codex-cli-customisation-stack-unified-system/)). | Hooks high; rest low to medium |
| pi | README of `@mariozechner/pi-coding-agent` 0.73.1 ([unpkg](https://app.unpkg.com/@mariozechner/pi-coding-agent@0.73.1/files/README.md)) | Medium; the extension event list is not fully documented there |
| Prime Agent (Prime Intellect, Aug 2026) | Official README ([PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent)); press for context | Medium; the README covers concepts, not the config format |
| DeepSeek Harness `dsh` (Aug 2026, dev preview) | Official repo docs: `docs/architecture.md`, `docs/capability-seams.md`, `docs/config-catalog.md` ([deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)) | Medium to high; the project announces breaking changes |

Verify anything marked *(?)* before relying on it.

---

## 0. The two newer harnesses at a glance

### Prime Agent: "everything is code"

- **One built-in model tool:** a persistent Python REPL (IPython kernel). File edits, shell,
  tool use, subagents and context management all happen as code inside it. State survives
  across turns and compaction.
- **Subagents** are function calls: `rlm.spawn(...)` returns results programmatically, and
  agents can message parent, child and sibling agents.
- **Skills** are importable Python packages (not `SKILL.md`), plus a built-in skill creator.
- **The Continual Harness:** the self-editable state has four parts: supplemental prompt notes,
  memories, skill descriptions and subagent specs. `/refine` makes small, evidence-backed
  updates from the trajectory. The base system prompt is immutable, and snapshots allow
  rollback.
- **Long-running features:** `/goal`, heartbeats, schedules, a daemon that survives terminal
  disconnects, and `/autonomous` with turn, token and time budgets plus user-defined quality
  gates.
- **No hooks and no sandbox** are documented. The README says the worker processes are "not a
  security sandbox".

### DeepSeek Harness (`dsh`): "everything is a plugin"

- **Built on Cordis.** Every part is a replaceable plugin, including the model adapter, the tool
  registry, the session log and the agent loop itself. A running `dsh` is a plugin tree composed
  from YAML layers: profile → bundles → `cordis.patch.yml` → `--patch` overlays.
- **Capability seams:** each capability has three roles: a *Service Definition* (the
  interface), a *Service Provider* (the implementation) and a *Consumer* (often a model-facing
  tool). Swapping the provider changes the implementation without touching the consumer.
  Pointing the fs and subprocess providers at a remote sandbox moves Bash, PTY and LSP with them.
  **This is the closest prior art to Fausth's "the file declares, the host implements".**
- **Agent presets:** YAML-declared per-session compositions (`ctx.agentPresets`). A preset is a
  tree of plugin rows, i.e. code packages, not a portable interface description.
- **Tool presentation mode** (`dsh-agent-tool-presentation`): `native` sends every tool schema;
  `ptc` sends only `run_code` plus a generated SDK. Prime Agent's style becomes a configuration
  switch here.
- **Hooks:** its own waterfall events (`agent/pre-step`, `tools/pre-execute`,
  `tools/post-execute`, `agent/turn-stopping`, …), plus bridges that **load an existing Claude
  Code `hooks.json` or Codex `hooks.json` unchanged** (`dsh-hooks-claude-code`,
  `dsh-hooks-codex`).
- **Subagents** are a seam with providers: in-process spawn, in-process fork, ACP, **Codex,
  Claude Code**, and the dsh SDK. Delegating to another product is just another provider.
- **Permissions:** presets `workspace-write` / `danger-full-access`, which bundle sandbox mode
  and approval policy (the Codex vocabulary).
- **"Model-visible means logged":** every model request must be reconstructable from the
  session log, and new model-visible inputs require session events. This is the same principle
  as Fausth's replay fixtures.

### What these two add to the picture

1. **Tool presentation is part of the interface.** "Native schemas" vs "one code tool plus an
   SDK" is the biggest token-level difference between harnesses today. A Fausth file has to
   declare which one it uses. For a harness-native agent, the choice changes everything the
   model learns.
2. **Claude Code hooks are the lingua franca.** Codex copied them, and dsh loads them
   unchanged. Fausth should map 1:1 onto that event and decision vocabulary rather than invent
   its own.
3. **dsh is a host, not a format.** Its agents are plugin trees bound to dsh. A Fausth file is
   something a dsh plugin, Claude Code or Codex could *load*. Fausth doesn't compete with these
   harnesses; it is the file that runs on top of them. That is the strongest version of
   "anywhere".
4. **Prime Agent's self-editable state is the harness file itself:** prompt notes, memories,
   skill descriptions and subagent specs. That argues for the file being the unit that gets
   refined, versioned and rolled back (the harness hash already identifies versions). But it is
   a recipe on top, not core. A third-party write-up (unverified) reports that in a Factorio run a
   refined skill bypassed anti-cheat monitoring, which shows why refinement needs a check.

---

## 1. What each harness lets you configure

| Primitive | Claude Code | Codex | pi | Fausth v0.3 today |
|---|---|---|---|---|
| **Instructions / system prompt** | `CLAUDE.md` hierarchy, `.claude/rules/*.md`, output styles | `AGENTS.md` (root → cwd, `AGENTS.override.md` wins per level) | `SYSTEM.md` replaces, `APPEND_SYSTEM.md` appends; `AGENTS.md`/`CLAUDE.md` concatenated | `instinct_text`; the system message is assembled normatively (§15.3) |
| **Built-in tools** | Read, Edit, Write, Bash, Grep, Glob, WebFetch, … | shell, `apply_patch`, … | `read`, `write`, `edit`, `bash` (+ `grep`, `find`, `ls`) | none; all tools are declared and the host binds them |
| **External tools** | MCP (`.mcp.json`) | MCP (`config.toml`) | none (deliberately left out; possible via an extension) | connectors: inline, file, MCP (`connectors.yml`) |
| **Skills** | `SKILL.md` dirs | `SKILL.md` in `.agents/skills/` *(?)* | `SKILL.md` (Agent Skills standard) | none as such; `mutable: skills` patches tool descriptions |
| **Prompt templates / commands** | slash commands (merged into skills) | custom prompts *(?)* | `.pi/prompts/*.md` with `{{var}}` | none |
| **Hook events** | 33 events (see §2) | 12 events | extension events such as `tool_call` (list not fully documented) | none as a primitive; special cases are built in (see §3) |
| **Hook handler types** | `command`, `http`, `mcp_tool`, `prompt`, `agent` | `command`, `mcp_tool` (`prompt`/`agent` parsed but skipped) | TypeScript functions in-process | n/a |
| **Hook decision shape** | allow / deny / ask / defer, `updatedInput`, `updatedToolOutput`, `additionalContext`, `continue`, stop `decision: block` | allow / deny, `updatedInput`, `additionalContext`, `continue`, stop `decision: block` | whatever the extension does | structured `failure` objects on denies; closed reason codes |
| **Permissions** | allow / deny / ask rules (`Bash(npm test:*)`), permission modes, sandbox | `sandbox_mode`, `approval_policy` | none (deliberately left out; "use a container") | `permissions.tools` allowlist; filesystem scopes; secrets and protected paths (host-enforced) |
| **Memory** | instruction files + auto-memory directory (plain files) | instruction files | context files + session JSONL | `state` keys with provenance, `effects`, `invalidate_after`, `ttl_steps` |
| **Subagents** | `.claude/agents/*.md` (prompt, tools, model) | `.codex/agents/*.toml` *(?)* | none (deliberately left out) | `agent.spawn` with a tighten-only packet; roles = separate harness dirs |
| **User interaction** | permission prompts, AskUserQuestion, plan mode | approvals | none built in | `channel: user` tools answered by a recorded source, a simulator or a human |
| **Model selection** | settings, per-subagent `model` | profiles | `models.json` | deployment file; `overlays` (per-model narrowing + `prompt_hint`) |
| **Limits** | none user-facing *(?)* | subagent `max_threads` | none | `max_steps`, `max_tool_calls`, `timeout_ms` |
| **Sessions / compaction** | resume, compaction (+ hooks) | resume, compaction (+ hooks) | JSONL session tree, configurable compaction | run log only; no compaction |
| **Packaging** | plugins (skills, hooks, MCP, agents) | plugins | npm/git packages | signed bundles with a resolved IR |

## 2. Hook events: where the harnesses already agree

Codex cloned Claude Code's hook model: the same event names, the same `hookSpecificOutput`
shape, and it even accepts Claude Code tool-matcher aliases. That gives us a de facto standard.

| Event | Claude Code | Codex | Can block / steer |
|---|---|---|---|
| `SessionStart` | ✓ | ✓ | adds context |
| `UserPromptSubmit` | ✓ | ✓ | rejects the prompt |
| `PreToolUse` | ✓ | ✓ | allow / deny / rewrite input / add context |
| `PermissionRequest` | ✓ | ✓ | allow / deny |
| `PostToolUse` | ✓ | ✓ | replaces the result with feedback / adds context |
| `Stop` | ✓ | ✓ | `block` = "keep going", with the reason as the next prompt |
| `SubagentStart` / `SubagentStop` | ✓ | ✓ | SubagentStop like Stop |
| `PreCompact` / `PostCompact` | ✓ | ✓ | PreCompact can block |
| `SessionEnd` | ✓ | ✓ | none |
| `Interrupt` | — | ✓ | — |
| ~20 more (worktree, config, file watch, UI, tasks, MCP elicitation, model switch) | ✓ | — | mostly host or UI concerns |

**Reading:** about ten events are the shared core. Everything beyond them concerns the host's
UI or file system, not the agent's interface.

## 3. Fausth v0.3 features expressed as plain primitives

Most v0.3 features turn out to be special cases of a hook calling a tool.

| v0.3 feature | As a plain primitive | Note |
|---|---|---|
| `counterbalance.sequences` | `pre_tool` hook: deny unless a prior tool ran | recipe |
| `counterbalance.completion` | `stop` hook: block (keep going) unless done | recipe |
| `counterbalance.output_verifies` | `stop` hook on the final message | recipe |
| tool `verify` (evidence, absence, effect, output, judge) | `post_tool` hook | a `judge` verify is a hook whose tool is a model |
| `invalidate_after`, `ttl_steps` | `post_tool` hook on the memory tool | recipe |
| `counterbalance.orientation` | per-turn context hook (`additionalContext`) | recipe |
| `counterbalance.checkpoints` | ? | depends on whether engine-held `state` survives (open question 1) |
| tool `effects` + `state` | ? | same open question |
| `instinct_text` | `prompt` | rename only |
| `channel: user` | a tool binding (the host binds the tool to a human) | the rule "never answered from the model's arguments" stays |
| `agent.spawn` | `subagents` | keep "a child cannot get more permissions than its parent" |
| `mutable` + `harness.*` patch tools | ordinary tools + hooks | out of the core; a recipe |
| `recovery`, `fallback_state` | `stop`/failure hook | recipe |
| `intervention_budget`, `triggers` | drop | the engine never acted on them anyway |
| `overlays` | keep (per-model narrowing + prompt hint) | already the interface-varies-by-model mechanism |
| `permissions.tools` | keep | which tools the model is offered is interface |
| filesystem scopes, secrets, protected paths | move to the deployment / host side | sandboxing is behaviour, not interface |
| `limits` | keep | |

## 4. A candidate minimal primitive set

```yaml
name: tutor
prompt: prompts/tutor.md          # or inline text; assembled the same way on every host
skills: [skills/socratic]         # SKILL.md dirs, Agent Skills standard
tool_presentation: native         # native = one schema per tool | code = one run_code tool + generated SDK
tools:                            # interface only: id, description, input schema
  memory.save:  { description: ..., input: { key: string, text: string, reason: string } }
  memory.recall: { description: ..., input: { key: string } }
  judge.reason: { input: { reason: string }, hidden: true }   # hook-only: not offered to the model
hooks:
  - on: pre_tool
    match: memory.save
    run: judge.reason             # returns a decision (below)
subagents:
  reviewer: { harness: ./reviewer.yml }   # a child cannot get more permissions than its parent
permissions: { tools: [memory.save, memory.recall] }
limits: { max_steps: 200 }
```

The host's deployment file binds each tool id to a script, an HTTP endpoint, an MCP tool, a
model or a human.

**Decision shape (the one genuinely new normative piece):**

```yaml
decision: allow | deny | modify      # pre_tool
reason: <structured or text>
updated_input: {...}                 # modify only
context: <text>                      # add_context, any event
continue: true | false               # stop: false = done; true + reason = keep going
```

**Rendering (normative, part of the interface):** the exact tokens the model sees for each
decision kind. This replaces §15.3's "hosts MAY render prose from failure objects".

**Events:** start with the shared core from §2: `session_start`, `user_prompt`, `pre_tool`,
`post_tool`, `stop`, `subagent_start`, `subagent_stop`, `session_end`. Compaction events wait
until Fausth has compaction.

**Rules that keep it small:**
- A hook's tool never fires hooks itself.
- Hook-only tools are hidden from the model.
- No expressions in the file. A condition is a hook calling a tool.
- Design target: someone can write a third engine in a weekend.

## 5. Open questions

1. ~~**Does engine-held `state` survive?**~~ **Decided 2026-10-16: no. The log is the only
   state.** See §6 for the worked chess example.
2. **Hook ordering and combination.** If several hooks match one event, do they run in
   declaration order, and does the first deny win? (Codex runs matching hooks concurrently.)
3. **Hook-only tools.** Should they be declared alongside model tools (with a `hidden` flag), or
   in a separate `handlers:` block?
4. **Skills and prompt templates.** Should Fausth adopt the Agent Skills `SKILL.md` standard
   as-is? (Claude Code, Codex and pi already all read it.)
5. **Interop.** Should a host be able to compile a Fausth file into Claude Code or Codex config
   (`settings.json` hooks + `.claude/agents`)? Or should a dsh plugin load it directly? Either
   would be the strongest proof of "anywhere".
6. **Tool presentation.** Should `native` and `code` both be in v1, or only `native` first? `code`
   requires a normative SDK rendering: the generated function signatures *are* the interface.

## 6. Decision: the log is the only state (worked example)

**Decision (2026-10-16):** the engine keeps no state of its own. `state`, `effects`,
provenance, `invalidate_after`, `ttl_steps` and `checkpoints` leave the core. Rules are hooks
that read the event log, either through a few built-in hook tools that every engine implements
identically, or through the harness author's own tool, which receives the log as input. Agent
memory is a tool (`memory.save` / `memory.recall`) implemented by the host. The predicate
language survives only in a small form, as arguments to the built-ins.

**Example rule** (from `cb-ability-v1`, arm S1G1p, made stricter): *before each `board.move`,
`board.legal_moves` must have been called since the last move.*

Option A, engine state (v0.3): four mechanisms for one rule.

```yaml
state: { legal_checked: 0 }
tools:
  - id: board.legal_moves
    effects: [{ set: { legal_checked: 1 } }]
counterbalance:
  sequences:
    - id: check-before-move
      action: board.move
      require_state: { path: state.legal_checked, eq: 1 }
  invalidate_after:
    - { action: board.move, memory_keys: [legal_checked] }
```

Option B, host tool: tiny, but the bookkeeping moves into host code, which differs per host.

```yaml
hooks:
  - { on: pre_tool, match: board.move, run: rules.check_move }   # host keeps its own counter
```

Option C, the log plus built-ins (**chosen**):

```yaml
hooks:
  - on: pre_tool
    match: board.move
    run: fausth.called_since                      # built into every engine
    with: { tool: board.legal_moves, since: board.move }
```

|  | A: engine state | B: host tool | C: log + built-ins |
|---|---|---|---|
| Same enforcement on every host | yes | no | yes for built-ins |
| Runs without host code | yes | no | yes for built-ins |
| Complex rules (lists, chess logic) | the language must grow | yes | yes, via your own tool |
| What the spec has to define | state, effects, provenance, TTL, checkpoints, predicates | almost nothing | the log format + ~5 built-ins |
| Replay fixtures | as now | hook results recorded | built-ins computed; own tools recorded |

**Evidence from the real harness:** neither rule in S1G1p reads `state`. The sequences check the
log, and the verifies check the move's own result (`result.illegal`, `result.stale`). The
experiment's rules were already Option C under Counterbalance names.

**Cost:** the conformance fixtures for state, effects, checkpoints and provenance must be
rewritten. "Only the user tool may set key X" becomes "the user's answer is in the log, and a
hook reads it".

## 7. Decisions of 2026-10-16 (second round)

| # | Topic | Decision |
|---|---|---|
| 2 | Built-in hook tools | `called_since`, `last_result`, `count`, `user_answered`, `always_deny`. Add one only when a real harness needs it. |
| 3 | What a hook tool sees | The current event plus a filtered view of the log (tool calls and results), not the raw log. |
| 4 | Several hooks on one event | Declaration order; the first deny wins; modifications chain. |
| 5 | Events | The six shared events. Compaction is **not** an event: it is a hook that counts the context and replaces it. **Consequence:** this needs an event before each model request (`pre_request`) and a decision kind that replaces the context. That makes seven events. |
| 6 | Hook-only tools | A separate `handlers:` block. |
| 8 | Skills | No skills primitive. Reading a skill is a tool call (`skill.read`). Advertising skills is a `session_start` hook that adds their names and descriptions to the context. (Claude Code works the same way: a Skill tool plus a listing.) |
| 9 | Subagents | No special function: spawning is a tool whose input can be a **whole harness the parent writes**. That is a far richer transfer than a prompt ("true A2A"). The one guard the spec keeps: a written child harness can never have more permissions than its parent (a built-in check, because the orchestrator must not mint trust). |
| 10 | File vs deployment | The file keeps the tool allowlist and limits. Filesystem scopes, secrets and the sandbox move to the deployment. |
| 11 | Interrupt event | Yes, and **not tied to the user**: anything arriving from outside while the agent works (the user, a finished subagent, a background job, a timer, the opponent's move in the "no-sleep" chess archetype). Delivered only at step boundaries; in replay it is recorded with the step at which it arrived. |
| 12 | Self-refinement | Not in the spec. It is built from flexible tools (for example `call_proto_tool(name, args)`) and, optionally, a harness file that is re-read live. The spec only needs to say when a reloaded file takes effect (the next step boundary) and that the log records the new harness hash. |
| 13 | Interop | **Not** compiling to Claude Code: starting a Claude Code session per bot is exactly the Rakazo inefficiency "anywhere" should avoid. The first proof of "anywhere" should be a *light* host (for example the engine running in a browser page). |
| 14 | v0.3 | Retired. It stays only as a record of the journey; no compatibility. |
| 15 | Name | Something mythical that conveys spartan/raw/anywhere. "Hermes" is taken: Nous Research's *Hermes Agent* is an open-source harness with a very similar pitch. |

**Decided later the same day:** #7: code-executing tools are allowed and **opaque**. Hooks see
only top-level tool calls; the log records the code tool's call and result, not what ran inside.
No `invoke` rule: an agent with an interpreter running at the host's privileges can bypass host
tools anyway, so the rule would only pretend to enforce something. Enforcing rules while offering
a raw exec tool is the harness author's design problem, not the spec's. #11 and #13 confirmed.

**Still open:** #1 how hook decisions render into model tokens; the light host for #13; the name.

**The bypass problem with code-executing tools (#7):** a `python.exec` tool is just a tool, so
no presentation mode is needed in the spec. A harness that offers only `python.exec` *is*
Prime Agent's design. But if code running inside `python.exec` calls another declared tool
(`board.move`) directly, no `pre_tool` hook fires and nothing is logged. Then the rules and
"the log is the only state" are both bypassed. Candidate rule: a tool may call other declared
tools only through the engine (a host callback such as `invoke(tool, args)`), so hooks fire and
the log stays complete.

**Prior art to add to §0:** Nous Research *Hermes Agent* (Feb 2026: skills created from
trajectories, cross-session user memory, a messaging gateway).

## 8. Decision #1: how hook decisions reach the model (2026-10-16)

**Decided:** one wrapper for every decision, fixed by the spec, with the hook id shown:

```text
<hook event="pre_tool" id="check-before-move" decision="deny">board.legal_moves not called since the last board.move</hook>
```

- Tags, not JSON or prose: they stay apart from world output (tool results are usually JSON),
  and a fine-tuned model has one pattern to learn.
- Built-in hook tools use fixed templates defined in the spec. Custom hook tools supply their
  own reason text, which goes inside unchanged (length-capped, secrets redacted). This
  deliberately reverses v0.3's "the engine never emits prose".
- The hook id is shown: it costs a few tokens and teaches the model which rule it hit.

**Placement (proposed; the user did not object, but it was not explicitly confirmed):**

| Decision | Lands |
|---|---|
| `deny` before a tool | as that tool call's result |
| `modify` input | the tool runs; its result starts with a `decision="modify"` note naming what changed |
| replace result after a tool | the hook text replaces the result, inside the wrapper |
| `add_context` | attached to the next thing the model reads: in the tool result for tool events, otherwise a user-role message. No system messages mid-conversation. |
| `stop` → keep going | a new user-role message |
| `interrupt` | a user-role message at the step boundary, with `source=` |
| replace context (compaction) | the old messages are swapped out; the new context starts with one fixed marker line, then the hook's summary |
| `session_start` context | appended to the system prompt after the harness prompt, in hook order; the only system-level injection |

**Still open:** whether `user_prompt` context goes before or after the user's text; the exact
wording of the built-in templates (after the built-ins are final).
