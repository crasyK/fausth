# Production isolation (deferred scope)

**Status:** Deferred (P3). Alpha containment remains disposable linked worktree + path scopes + argv allowlist.

## What exists today

See [`engines/ts/src/adapters/local.ts`](../../engines/ts/src/adapters/local.ts) and [`sandbox-path.ts`](../../engines/ts/src/adapters/sandbox-path.ts):

- Must use a **linked disposable git worktree** (not the primary checkout)
- Path containment (no `..`, absolutes, `.git`; symlink checks)
- Shell via `execFile` with fixed argv map (`test` / `typecheck`)
- Byte/time caps on read/output/shell

MCP `stdio` and future `module` subprocesses are **not** sandboxed.

## What claiming “production isolation” requires

| Layer | Work |
|-------|------|
| OS sandbox | seccomp/Landlock/namespaces (Linux), Job Objects (Windows) |
| Container adapter | Per-run container image + egress policy wrapping `local.ts` |
| Network egress | Default-deny + allowlisted hosts |
| Multi-tenant | Worktree pools, quotas, secret isolation, scheduling |
| Module/MCP | Sandboxed subprocesses (ties to M17) |

## Claim gate

Do **not** remove the README “production isolation” disclaimer until:

1. A written threat model covers FS, process, network, and secret exfil
2. A container-or-OS sandbox adapter ships with Track A-style regression tests where feasible
3. Third-party-style review of the isolation boundary

Until then, alpha advice stands: do not point `--workspace` at valuable checkouts; treat signatures as integrity, not trust for untrusted authors.
