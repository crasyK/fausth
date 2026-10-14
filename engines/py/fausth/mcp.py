"""MCP host adapters: recorded (Track A) and stdio (live) transports.

Mirrors TS adapters/mcp.ts + adapters/stdio-session.ts:

- children get an allowlisted environment (never ``{**os.environ}``): API keys, tokens
  and other secret-looking variables are never forwarded (EDGE-9);
- stderr is drained by a thread into a bounded tail so a chatty server cannot block
  on a full pipe; every live session is closed by ``cleanup`` and at interpreter exit
  (EDGE-10);
- recorded paths must stay inside the harness directory and match the call args
  exactly — no tool-only fallback that would return another call's result (PY-19);
- a deployment shipped inside a bundle may only spawn operator-allowed commands
  (``FAUSTH_ALLOW_COMMANDS``) and never from unsigned/untrusted bundles unless
  ``FAUSTH_ALLOW_UNTRUSTED_BUNDLE_COMMANDS=1`` (PY-3).
"""
from __future__ import annotations

import atexit
import json
import os
import re
import subprocess
import threading
import weakref
from pathlib import Path
from typing import Any, Callable

from .adapter_error import AdapterError
from .canonical import canonical_json
from .provenance import bundle_provenance_for

#: Env var names that must never be forwarded to a child process.
SECRET_ENV_NAME_RE = re.compile(
    r"(api[_-]?key|access[_-]?key|secret|password|passwd|token|credential|authorization|"
    r"private[_-]?key|cookie|session)",
    re.I,
)
#: Kept for callers that imported the old name.
SECRET_KEY_RE = SECRET_ENV_NAME_RE

#: Non-secret host variables a child may inherit by default (same list as TS).
BASE_ENV_ALLOWLIST: tuple[str, ...] = (
    "PATH",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "LC_MESSAGES",
    "TZ",
    "TERM",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "COMSPEC",
    "PATHEXT",
    "WINDIR",
)

STDERR_TAIL_BYTES = 8192

ToolHandler = Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]]


def parse_mcp_native(native: str) -> tuple[str, str] | None:
    if not native.startswith("mcp."):
        return None
    rest = native[len("mcp.") :]
    dot = rest.find(".")
    if dot <= 0 or dot == len(rest) - 1:
        return None
    return rest[:dot], rest[dot + 1 :]


def deployment_uses_mcp(deployment: dict[str, Any]) -> bool:
    for b in (deployment.get("bindings") or {}).values():
        n = b.get("native") if isinstance(b, dict) else None
        if isinstance(n, str) and n.startswith("mcp."):
            return True
    return False


def mcp_tool_map_from_resolved(resolved: dict[str, Any] | None) -> dict[str, str]:
    out: dict[str, str] = {}
    if not resolved:
        return out
    for c in resolved.get("resolution", {}).get("connectors") or []:
        if c.get("kind") != "mcp":
            continue
        for tid, name in (c.get("mcp_tools") or {}).items():
            out[str(tid)] = str(name)
    return out


# ---------------------------------------------------------------------------
# Child environment (EDGE-9)
# ---------------------------------------------------------------------------


def assert_no_secret_env_names(names: Any, label: str = "mcp") -> None:
    for k in names or []:
        if SECRET_ENV_NAME_RE.search(str(k)):
            raise AdapterError(
                "adapter_unresolved",
                f"adapter failure: forbidden secret-like {label} env key '{k}'",
            )


def build_child_env(
    *,
    passthrough: list[str] | None = None,
    set_env: dict[str, str] | None = None,
    source: dict[str, str] | None = None,
    label: str = "child",
) -> dict[str, str]:
    """Minimal child environment from an allowlist (never a copy of the host env)."""
    src = os.environ if source is None else source
    passthrough = list(passthrough or [])
    set_env = dict(set_env or {})
    assert_no_secret_env_names(passthrough, label)
    assert_no_secret_env_names(set_env.keys(), label)
    out: dict[str, str] = {}
    for name in (*BASE_ENV_ALLOWLIST, *passthrough):
        v = src.get(name)
        if isinstance(v, str):
            out[name] = v
    for k, v in set_env.items():
        if not isinstance(v, str):
            raise AdapterError("adapter_unresolved", f"adapter failure: {label} env value for '{k}' must be a string")
        out[k] = v
    out["GIT_CONFIG_NOSYSTEM"] = "1"
    out["GIT_CONFIG_GLOBAL"] = "NUL" if os.name == "nt" else "/dev/null"
    out["GIT_TERMINAL_PROMPT"] = "0"
    return out


# Back-compat name used by older callers.
def _assert_no_secret_env(env: dict[str, str] | None) -> None:
    assert_no_secret_env_names((env or {}).keys(), "mcp")


# ---------------------------------------------------------------------------
# Spawn policy (PY-3)
# ---------------------------------------------------------------------------


def spawn_policy_from_env(env: dict[str, str] | None = None) -> dict[str, Any]:
    src = os.environ if env is None else env
    raw = (src.get("FAUSTH_ALLOW_COMMANDS") or "").strip()
    allow: Any = "*" if raw == "*" else [s.strip() for s in raw.split(",") if s.strip()]
    untrusted = (src.get("FAUSTH_ALLOW_UNTRUSTED_BUNDLE_COMMANDS") or "").strip()
    return {"allow_commands": allow, "allow_untrusted_bundles": untrusted in ("1", "true")}


def assert_spawn_allowed(command: str, policy: dict[str, Any] | None, label: str) -> None:
    prov = (policy or {}).get("provenance")
    if not prov:
        return  # deployment provided by the operator, not by a bundle
    allow = (policy or {}).get("allow_commands")
    allowed = allow == "*" or (isinstance(allow, (list, tuple)) and command in allow)
    bundle_name = Path(str(prov.get("bundle", ""))).name
    trust = prov.get("trust")
    if not allowed:
        raise AdapterError(
            "spawn_not_allowed",
            f"adapter failure: {label} command '{command}' is declared by a deployment shipped inside "
            f"bundle {bundle_name} ({trust}); the operator must allow it (FAUSTH_ALLOW_COMMANDS)",
        )
    if trust != "signed-trusted" and not (policy or {}).get("allow_untrusted_bundles"):
        raise AdapterError(
            "spawn_not_allowed",
            f"adapter failure: refusing to spawn '{command}' from a {trust} bundle ({bundle_name}); "
            "sign it with a trusted key or set FAUSTH_ALLOW_UNTRUSTED_BUNDLE_COMMANDS=1",
        )


# ---------------------------------------------------------------------------
# Recorded responses (PY-19)
# ---------------------------------------------------------------------------


def resolve_harness_file(harness_dir: str | Path, rel_path: Any, label: str) -> Path:
    """Resolve a deployment-declared harness-relative file, contained in the harness dir."""
    if (
        not isinstance(rel_path, str)
        or not rel_path
        or "\0" in rel_path
        or rel_path.startswith(("/", "\\", "~"))
        or re.match(r"^[a-zA-Z]:", rel_path)
    ):
        raise AdapterError("adapter_unresolved", f"adapter failure: {label} path must be harness-relative: {rel_path!r}")
    unified = rel_path.replace("\\", "/")
    if ".." in unified.split("/"):
        raise AdapterError("adapter_unresolved", f"adapter failure: {label} path escapes the harness: {rel_path}")
    root = Path(harness_dir).resolve()
    candidate = root / unified
    if not candidate.exists():
        raise AdapterError("adapter_unresolved", f"adapter failure: {label} file not found: {rel_path}")
    real = candidate.resolve()
    try:
        real.relative_to(root)
    except ValueError as e:
        raise AdapterError("adapter_unresolved", f"adapter failure: {label} path escapes the harness: {rel_path}") from e
    if not real.is_file():
        raise AdapterError("adapter_unresolved", f"adapter failure: {label} file not found: {rel_path}")
    return real


def _load_recorded(harness_dir: Path, rel_path: str) -> list[dict[str, Any]]:
    abs_path = resolve_harness_file(harness_dir, rel_path, "mcp recorded")
    entries: list[dict[str, Any]] = []
    text = abs_path.read_bytes().decode("utf-8")
    for i, line in enumerate(re.split(r"\r?\n", text), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as e:
            raise AdapterError(
                "adapter_unresolved",
                f"adapter failure: invalid mcp recorded line {i} in {rel_path}",
            ) from e
        args = row.get("args") if isinstance(row, dict) else None
        if (
            not isinstance(row, dict)
            or not isinstance(row.get("tool"), str)
            or not isinstance(row.get("result"), dict)
            or (args is not None and not isinstance(args, dict))
        ):
            raise AdapterError(
                "adapter_unresolved",
                f"adapter failure: invalid mcp recorded line {i} in {rel_path}",
            )
        entries.append(row)
    return entries


def _match_recorded(
    entries: list[dict[str, Any]],
    tool: str,
    args: dict[str, Any],
    used: set[int],
) -> dict[str, Any]:
    """First unused entry with canonically equal args; no tool-only fallback."""
    args_canon = canonical_json(args or {})
    for i, e in enumerate(entries):
        if i in used or e["tool"] != tool:
            continue
        if canonical_json(e.get("args") or {}) == args_canon:
            used.add(i)
            return e["result"]
    raise AdapterError(
        "recorded_response_missing",
        f"adapter failure: no recorded mcp response for tool '{tool}' with these args",
    )


# ---------------------------------------------------------------------------
# Live sessions (EDGE-10)
# ---------------------------------------------------------------------------

_LIVE_SESSIONS: "weakref.WeakSet[_StdioMcpSession]" = weakref.WeakSet()


def close_all_host_sessions() -> None:
    for s in list(_LIVE_SESSIONS):
        s.close()


def live_host_session_count() -> int:
    return sum(1 for s in list(_LIVE_SESSIONS) if not s.closed)


atexit.register(close_all_host_sessions)


class _StdioMcpSession:
    def __init__(
        self,
        command: str,
        args: list[str],
        env: dict[str, str] | None,
        timeout_ms: int,
        cwd: str | None = None,
        *,
        env_passthrough: list[str] | None = None,
        label: str = "mcp server",
    ) -> None:
        self.timeout_s = timeout_ms / 1000.0
        self._next_id = 1
        self._lock = threading.Lock()
        self._pending: dict[int, tuple[threading.Event, dict[str, Any]]] = {}
        self._stderr_tail = ""
        self.closed = False
        child_env = build_child_env(passthrough=env_passthrough, set_env=env, label="mcp")
        self.proc = subprocess.Popen(
            [command, *args],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=child_env,
            cwd=cwd,
        )
        _LIVE_SESSIONS.add(self)
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()
        self._err_reader = threading.Thread(target=self._drain_stderr, daemon=True)
        self._err_reader.start()

    def _read_loop(self) -> None:
        assert self.proc.stdout is not None
        for raw in self.proc.stdout:
            try:
                msg = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            if not isinstance(msg, dict):
                continue
            mid = msg.get("id")
            with self._lock:
                slot = self._pending.get(mid) if isinstance(mid, int) else None
            if slot is None:
                continue  # late reply for a timed-out id: dropped, never re-attributed
            event, box = slot
            box["msg"] = msg
            event.set()
        # stdout closed → process gone: fail every pending request.
        self.closed = True
        with self._lock:
            pending = list(self._pending.values())
        for event, box in pending:
            box.setdefault("exited", True)
            event.set()

    def _drain_stderr(self) -> None:
        assert self.proc.stderr is not None
        while True:
            chunk = self.proc.stderr.read1(4096)  # type: ignore[union-attr]
            if not chunk:
                return
            self._stderr_tail = (self._stderr_tail + chunk.decode("utf-8", "replace"))[-STDERR_TAIL_BYTES:]

    def stderr_tail(self) -> str:
        return self._stderr_tail

    def _write(self, payload: dict[str, Any]) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write((json.dumps(payload) + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def _request(self, method: str, params: Any = None) -> Any:
        if self.closed:
            raise RuntimeError("mcp stdio session closed")
        with self._lock:
            rid = self._next_id
            self._next_id += 1
            event = threading.Event()
            box: dict[str, Any] = {}
            self._pending[rid] = (event, box)
        payload: dict[str, Any] = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            payload["params"] = params
        try:
            self._write(payload)
            if not event.wait(self.timeout_s):
                raise TimeoutError(f"mcp stdio timeout after {self.timeout_s}s ({method})")
        finally:
            with self._lock:
                self._pending.pop(rid, None)
        if box.get("exited") and "msg" not in box:
            raise RuntimeError("mcp stdio process exited")
        msg = box.get("msg") or {}
        if "error" in msg:
            err = msg["error"]
            raise RuntimeError(str(err.get("message", err) if isinstance(err, dict) else err))
        return msg.get("result")

    def initialize(self) -> None:
        self._request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "fausth", "version": "0.4.0-alpha"},
            },
        )
        self._write({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def call_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        result = self._request("tools/call", {"name": name, "arguments": args})
        if isinstance(result, dict):
            structured = result.get("structuredContent")
            if isinstance(structured, dict):
                return structured
            for block in result.get("content") or []:
                if isinstance(block, dict) and block.get("type") == "text":
                    text = block.get("text")
                    if isinstance(text, str):
                        try:
                            parsed = json.loads(text)
                            if isinstance(parsed, dict):
                                return parsed
                        except json.JSONDecodeError:
                            pass
                        return {"text": text}
        raise RuntimeError(f"mcp tools/call '{name}' returned no structured result")

    def close(self) -> None:
        self.closed = True
        try:
            if self.proc.poll() is None:
                self.proc.kill()
            self.proc.wait(timeout=5)
        except Exception:
            pass
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                if stream is not None:
                    stream.close()
            except Exception:
                pass
        _LIVE_SESSIONS.discard(self)


def create_mcp_handlers(
    deployment: dict[str, Any],
    *,
    harness_dir: str | Path,
    mcp_tool_map: dict[str, str] | None = None,
    deployment_path: str | Path | None = None,
    spawn_policy: dict[str, Any] | None = None,
) -> tuple[dict[str, ToolHandler], dict[str, str], Callable[[], None]]:
    """Build handlers for ``mcp.*`` natives; returns ``(handlers, native_to_tool, cleanup)``.

    ``cleanup`` terminates every stdio session (callers must invoke it; interpreter exit
    also does). ``spawn_policy`` defaults to the operator environment.
    """
    handlers: dict[str, ToolHandler] = {}
    native_to_tool: dict[str, str] = {}
    sessions: dict[str, _StdioMcpSession] = {}
    recorded_cache: dict[str, list[dict[str, Any]]] = {}
    recorded_used: dict[str, set[int]] = {}
    mcp_cfg = deployment.get("mcp") or {}
    tool_map = mcp_tool_map or {}
    root = Path(harness_dir).resolve()
    policy = dict(spawn_policy if spawn_policy is not None else spawn_policy_from_env())
    policy["provenance"] = bundle_provenance_for(deployment_path or harness_dir)

    for tool_id, binding in (deployment.get("bindings") or {}).items():
        if not isinstance(binding, dict):
            continue
        native = binding.get("native")
        if not isinstance(native, str) or not native.startswith("mcp."):
            continue
        parsed = parse_mcp_native(native)
        if parsed is None:
            raise AdapterError(
                "adapter_unresolved",
                f"adapter failure: invalid mcp native '{native}' (expected mcp.<server>.<tool>)",
            )
        server_id, mapped_tool = parsed
        if mapped_tool != tool_id:
            raise AdapterError(
                "adapter_unresolved",
                f"adapter failure: native '{native}' maps to '{mapped_tool}', not '{tool_id}'",
            )
        server = mcp_cfg.get(server_id) if isinstance(mcp_cfg, dict) else None
        if not isinstance(server, dict):
            raise AdapterError(
                "adapter_unresolved",
                f"adapter failure: no deployment.mcp['{server_id}'] for native '{native}'",
            )
        native_to_tool[native] = tool_id
        remote_name = tool_map.get(tool_id, tool_id)
        transport = server.get("transport")

        if transport == "recorded":
            recorded_path = server.get("recorded")
            if not isinstance(recorded_path, str) or not recorded_path:
                raise AdapterError(
                    "adapter_unresolved",
                    f"adapter failure: mcp server '{server_id}' recorded transport requires recorded path",
                )

            def make_recorded(
                sid: str = server_id,
                rpath: str = recorded_path,
                rname: str = remote_name,
            ) -> ToolHandler:
                def handler(args: dict[str, Any], _ctx: dict[str, Any]) -> dict[str, Any]:
                    if sid not in recorded_cache:
                        recorded_cache[sid] = _load_recorded(root, rpath)
                        recorded_used[sid] = set()
                    result = _match_recorded(recorded_cache[sid], rname, args, recorded_used[sid])
                    return {"output": result}

                return handler

            handlers[tool_id] = make_recorded()
            continue

        if transport == "stdio":
            command = server.get("command")
            if not isinstance(command, str) or not command:
                raise AdapterError(
                    "adapter_unresolved",
                    f"adapter failure: mcp server '{server_id}' stdio transport requires command",
                )
            env = server.get("env")
            if env is not None and not isinstance(env, dict):
                raise AdapterError(
                    "adapter_unresolved",
                    f"adapter failure: mcp server '{server_id}' env must be an object",
                )
            passthrough = server.get("env_passthrough")
            if passthrough is not None and not isinstance(passthrough, list):
                raise AdapterError(
                    "adapter_unresolved",
                    f"adapter failure: mcp server '{server_id}' env_passthrough must be a list of names",
                )
            assert_no_secret_env_names([*(env or {}).keys(), *(passthrough or [])], "mcp")
            timeout_ms = int(server.get("timeout_ms") or 15_000)
            args = list(server.get("args") or [])

            def make_stdio(
                sid: str = server_id,
                cmd: str = command,
                cmd_args: list[str] = args,
                env_map: dict[str, str] | None = env,
                env_pass: list[str] | None = passthrough,
                timeout: int = timeout_ms,
                rname: str = remote_name,
            ) -> ToolHandler:
                def handler(call_args: dict[str, Any], _ctx: dict[str, Any]) -> dict[str, Any]:
                    session = sessions.get(sid)
                    if session is not None and session.closed:
                        sessions.pop(sid, None)
                        session = None
                    if session is None:
                        assert_spawn_allowed(cmd, policy, "mcp stdio")
                        try:
                            session = _StdioMcpSession(
                                cmd,
                                cmd_args,
                                env_map,
                                timeout,
                                cwd=str(root),
                                env_passthrough=env_pass,
                                label=f"mcp server '{sid}'",
                            )
                        except OSError as e:
                            raise AdapterError(
                                "host_session_failed",
                                f"adapter failure: mcp stdio spawn failed: {e}",
                            ) from e
                        sessions[sid] = session
                        try:
                            session.initialize()
                        except Exception as e:
                            session.close()
                            sessions.pop(sid, None)
                            raise AdapterError(
                                "host_session_failed",
                                f"adapter failure: mcp stdio initialize failed: {e}",
                            ) from e
                    try:
                        return {"output": session.call_tool(rname, call_args)}
                    except AdapterError:
                        raise
                    except Exception as e:
                        raise AdapterError(
                            "host_session_failed",
                            f"adapter failure: mcp tools/call failed: {e}",
                        ) from e

                return handler

            handlers[tool_id] = make_stdio()
            continue

        raise AdapterError(
            "adapter_unresolved",
            f"adapter failure: unsupported mcp transport {transport!r}",
        )

    def cleanup() -> None:
        for s in list(sessions.values()):
            s.close()
        sessions.clear()

    return handlers, native_to_tool, cleanup
