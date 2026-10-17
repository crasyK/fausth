# Production isolation (deferred scope)

**Status:** Deferred (P3). Fausth's local adapter is **not a sandbox**. It is a set of
host-side checks around a disposable linked git worktree. This page says what those checks
guarantee, what they do not, and what "production isolation" would still require.

Updated 2026-10-13 (audit fixes EDGE-2/4/5/6/7/8/9/10/18/19/20, PY-3).

## What the host enforces today

Code: [`engines/ts/src/adapters/local.ts`](../engines/ts/src/adapters/local.ts),
[`sandbox-path.ts`](../engines/ts/src/adapters/sandbox-path.ts),
[`child-process.ts`](../engines/ts/src/adapters/child-process.ts),
[`stdio-session.ts`](../engines/ts/src/adapters/stdio-session.ts),
[`worlds/tau.ts`](../engines/ts/src/adapters/worlds/tau.ts);
Python MCP host: [`engines/py/fausth/mcp.py`](../engines/py/fausth/mcp.py).

### Filesystem tools (`fs.read` / `fs.list` / `fs.write_scoped`)

- The workspace must be a **linked disposable git worktree**, never the primary checkout.
- Paths and scopes are POSIX-normalized before any check (D7): `./x`, `a//x`, `a/./x`,
  `a\x` all mean `a/x`; absolute paths, NUL, `..` and `.git` components are rejected;
  `src` ≡ `src/`; the whole worktree is granted only by an explicit `.` scope.
- Every check runs on the normalized lexical path **and** on the resolved real path, so
  an in-worktree symlink (`src/link -> ../secrets`) cannot widen a scope or alias a
  protected / host-control file. Symlinks leaving the worktree and dangling symlinks are
  refused.
- `fs.write_scoped` runs **all** checks before writing a byte: host control path → write
  scope → protected path → secret content → plan paths (warn-then-deny). Writes are atomic
  (temp file + rename).
- **Host control files** are never agent-writable: `.fausth/` always, plus whatever a
  domain world declares (the τ world reserves `tau/todos.json`, `tau/actions.jsonl`,
  `tau/request.json`, `tau/response.txt`, `tau/outputs.log`). Host-derived state is read
  back only from these. The approved-plan record (`.fausth/approved_paths.json`) is read
  once, when the world is created, before the agent acts.
- Deployment `world.scopes` may only **narrow** agent scopes. An agent that declares no
  write scopes gets no writes, whatever the deployment says; `write: []` means no writes.

### World commands (`shell.run_allowlisted`, domain commands such as `tau`)

- Only argv lists declared in `deployment.world.commands` run (own keys only — `constructor`
  or `__proto__` are not commands), via `spawn` without a shell.
- **Environment allowlist:** `PATH`, locale, `TZ`, `TERM`, temp-dir variables (plus Windows
  essentials). Nothing else is inherited. A deployment may add non-secret names with
  `world.env_passthrough: [NAME]` or literal values with `world.env: {NAME: value}`; names
  that look secret (`*_API_KEY`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, credentials, cookies,
  sessions, private keys) are refused even when declared.
- **Private `HOME`** (and XDG dirs) per world; git's global/system config is disabled
  (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`), so credential helpers and
  `~/.gitconfig` hooks are not picked up by tools that read them through `HOME`/git.
- Output is streamed into bounded buffers; the observation keeps the **true exit code**
  (timeouts → `124` + `error: "timeout"`, missing binary → `127`), is truncated by code
  points (D2) to `max_output_bytes`, and is **secret-redacted** (labeled secret values,
  values of secret-looking host env vars, high-signal token shapes) before the agent or
  the event log sees it (D13).
- The command's whole process group is killed on timeout and after it exits.
- After every command the host **verifies and restores** protected paths, host control
  files, and the git hooks / `config` / `config.worktree` / `.git` pointer of the
  worktree's repository. Any drift is reverted, reported as `protected_modified: 1`,
  withholds test evidence, and is logged host-side (`world.tamperLog`).

### MCP / module stdio servers

- Same environment allowlist (`env` / `env_passthrough` per server; secret-looking names
  refused). stderr is drained into a bounded tail; children are tracked and killed by the
  binding's `cleanup` and on process exit.
- **Bundle provenance:** a deployment file that shipped inside a `.fausth.json` bundle may
  only spawn commands the operator allowed (`FAUSTH_ALLOW_COMMANDS=cmd1,cmd2` or `*`), and
  never from an unsigned or untrusted bundle unless the operator also sets
  `FAUSTH_ALLOW_UNTRUSTED_BUNDLE_COMMANDS=1`. Trust comes from the operator's trust store
  (`FAUSTH_TRUSTED_KEYS`, see [`harness-packaging-roadmap.md`](harness-packaging-roadmap.md)).
- Recorded (Track A) responses must live inside the harness directory and match the call
  arguments exactly — an unrecorded call is an adapter error, never another call's result.

## Residual risk — read this before pointing `--workspace` at anything

World commands such as `node --test` or `pytest` **execute agent-written code with the
operator's uid**. The checks above reduce accidents and make tampering visible; they do not
contain a hostile test file. Such code can still:

- read any file the operator can read by absolute path (other checkouts, `.env` files,
  `~/.ssh`, `~/.config/gh`, …) — the private `HOME` only hides files from tools that look
  them up through `HOME`;
- open network connections and exfiltrate what it read (there is no egress control);
- write anywhere the operator can write; only protected paths, host control files and the
  repository's git hooks/config are restored afterwards — other files inside the worktree
  (outside write scopes) or outside it are not;
- start a background process that leaves the process group (`setsid`) and keeps running
  after the restore, e.g. to write a hook later;
- print secrets in shapes the redactor does not know.

Model-facing redaction is a best effort for honest logs (D13), not a confidentiality
boundary.

### Stronger isolation on this host

Checked 2026-10-13 on the research host: `bwrap` is not installed; `unshare` exists but
unprivileged user namespaces are blocked (`kernel.apparmor_restrict_unprivileged_userns =
1`), so neither network nor mount namespaces are available without root. Fausth therefore
does not ship a namespace wrapper yet; it would be untestable here. Run world commands in a
container or VM when the workspace or the network matters.

## What claiming "production isolation" requires

| Layer | Work |
|-------|------|
| OS sandbox | seccomp/Landlock/namespaces (Linux), Job Objects (Windows) around world commands |
| Container adapter | Per-run container image + egress policy wrapping `local.ts` |
| Network egress | Default-deny + allowlisted hosts |
| Read confinement | Only the worktree (and declared toolchains) visible to world commands |
| Multi-tenant | Worktree pools, quotas, secret isolation, scheduling |
| Module/MCP | Sandboxed subprocesses (ties to M17) |

## Claim gate

Do **not** remove the README "production isolation" disclaimer until:

1. A written threat model covers FS, process, network, and secret exfil
2. A container-or-OS sandbox adapter ships with Track A-style regression tests where feasible
3. Third-party-style review of the isolation boundary

Until then: do not point `--workspace` at valuable checkouts, run on a machine (or in a
container) whose readable files and credentials you are willing to expose to the model's
code, and treat bundle signatures as integrity + operator trust decisions — not as a
sandbox.
