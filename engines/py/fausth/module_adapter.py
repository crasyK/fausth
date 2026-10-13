"""Module connector host adapters (M17) — Python twin of TS ``adapters/module.ts`` +
the module half of ``adapters/stdio-session.ts``.

Transports: ``recorded`` (Track A; harness-contained file, exact args match, no
tool-only fallback) and ``stdio`` (one JSON line ``{tool, args}`` → one JSON line
``{output}`` | ``{error}``). The stdio protocol has no request ids, so calls are
serialized and a timed-out session is torn down — a late reply can never be
delivered to the next call. Children get an allowlisted environment, stderr is
drained into a bounded tail, every session is closed by ``cleanup`` and at
interpreter exit, and bundle-shipped deployments need operator allow to spawn.
"""
from __future__ import annotations

import atexit
import json
import re
import signal
import subprocess
import threading
import weakref
from pathlib import Path
from typing import Any, Callable

from .adapter_error import AdapterError
from .canonical import canonical_json, json_loads
from .mcp import (
    assert_no_secret_env_names,
    assert_spawn_allowed,
    build_child_env,
    resolve_harness_file,
    spawn_policy_from_env,
)
from .provenance import bundle_provenance_for

STDERR_TAIL_BYTES = 8192
ToolHandler = Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]]


def parse_module_native(native: str) -> tuple[str, str] | None:
    """``module.<server>.<tool>`` → ``(server, tool)``."""
    if not native.startswith("module."):
        return None
    rest = native[len("module."):]
    dot = rest.find(".")
    if dot <= 0 or dot == len(rest) - 1:
        return None
    return rest[:dot], rest[dot + 1:]


def deployment_uses_module(deployment: dict[str, Any]) -> bool:
    bindings = deployment.get("bindings") if isinstance(deployment, dict) else None
    return any(
        isinstance(b, dict) and isinstance(b.get("native"), str) and b["native"].startswith("module.")
        for b in (bindings or {}).values()
    )


# --------------------------------------------------------------------------
# Recorded responses
# --------------------------------------------------------------------------


def load_recorded_entries(harness_dir: str | Path, rel_path: str, label: str = "module") -> list[dict[str, Any]]:
    abs_path = resolve_harness_file(harness_dir, rel_path, f"{label} recorded")
    entries: list[dict[str, Any]] = []
    for i, line in enumerate(re.split(r"\r?\n", abs_path.read_bytes().decode("utf-8")), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            row = json_loads(line)
        except ValueError as e:
            raise AdapterError(
                "adapter_unresolved", f"adapter failure: invalid {label} recorded line {i} in {rel_path}"
            ) from e
        args = row.get("args") if isinstance(row, dict) else None
        if (
            not isinstance(row, dict)
            or not isinstance(row.get("tool"), str)
            or not isinstance(row.get("result"), dict)
            or ("args" in row and not isinstance(args, dict))
        ):
            raise AdapterError("adapter_unresolved", f"adapter failure: invalid {label} recorded line {i} in {rel_path}")
        entries.append(row)
    return entries


def match_recorded_exact(
    entries: list[dict[str, Any]], tool: str, args: dict[str, Any], used: set[int], label: str = "module"
) -> dict[str, Any]:
    """First unused entry for ``tool`` with canonically equal args (no tool-only fallback)."""
    args_canon = canonical_json(args or {})
    for i, e in enumerate(entries):
        if i in used or e["tool"] != tool:
            continue
        if canonical_json(e.get("args") or {}) != args_canon:
            continue
        used.add(i)
        return e["result"]
    raise AdapterError(
        "recorded_response_missing",
        f"adapter failure: no recorded {label} response for tool '{tool}' with these args",
    )


# --------------------------------------------------------------------------
# stdio sessions
# --------------------------------------------------------------------------

_LIVE: "weakref.WeakSet[ModuleStdioSession]" = weakref.WeakSet()


def close_all_module_sessions() -> None:
    for s in list(_LIVE):
        s.close()


def live_module_session_count() -> int:
    return sum(1 for s in list(_LIVE) if not s.closed)


atexit.register(close_all_module_sessions)


def _exit_text(label: str, code: int | None) -> str:
    if code is None:
        return f"{label} process exited (code=null, signal=null)"
    if code < 0:
        try:
            name = signal.Signals(-code).name
        except ValueError:
            name = str(-code)
        return f"{label} process exited (code=null, signal={name})"
    return f"{label} process exited (code={code}, signal=null)"


class ModuleStdioSession:
    """One child process speaking the module line protocol; calls are serialized."""

    def __init__(
        self,
        command: str,
        args: list[str],
        *,
        env: dict[str, str] | None,
        env_passthrough: list[str] | None,
        cwd: str | None,
        timeout_ms: int,
        label: str,
    ) -> None:
        self.label = label
        self.timeout_ms = timeout_ms
        self._call_lock = threading.Lock()
        self._state = threading.Lock()
        self._waiter: tuple[threading.Event, dict[str, Any]] | None = None
        self._broken: Exception | None = None
        self._closed = False
        self._stderr_tail = ""
        child_env = build_child_env(passthrough=env_passthrough, set_env=env, label="module")
        self.proc = subprocess.Popen(
            [command, *args],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=child_env,
            cwd=cwd,
        )
        _LIVE.add(self)
        threading.Thread(target=self._read_loop, daemon=True).start()
        threading.Thread(target=self._drain_stderr, daemon=True).start()

    @property
    def closed(self) -> bool:
        return self._closed or self._broken is not None

    def _read_loop(self) -> None:
        assert self.proc.stdout is not None
        for raw in self.proc.stdout:
            with self._state:
                w, self._waiter = self._waiter, None
            if w is not None:  # unsolicited lines are ignored, never queued for a later call
                w[1]["line"] = raw.decode("utf-8", "replace").rstrip("\r\n")
                w[0].set()
        code = self.proc.wait()
        err = RuntimeError(_exit_text(self.label, code))
        with self._state:
            if self._broken is None:
                self._broken = err
            w, self._waiter = self._waiter, None
        if w is not None:
            w[1]["error"] = err
            w[0].set()

    def _drain_stderr(self) -> None:
        assert self.proc.stderr is not None
        while True:
            chunk = self.proc.stderr.read1(4096)  # type: ignore[union-attr]
            if not chunk:
                return
            self._stderr_tail = (self._stderr_tail + chunk.decode("utf-8", "replace"))[-STDERR_TAIL_BYTES:]

    def stderr(self) -> str:
        return self._stderr_tail

    def call_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        with self._call_lock:  # the protocol has no request ids
            if self.closed:
                raise self._broken or RuntimeError("module stdio session closed")
            event = threading.Event()
            box: dict[str, Any] = {}
            with self._state:
                self._waiter = (event, box)
            try:
                assert self.proc.stdin is not None
                self.proc.stdin.write((json.dumps({"tool": name, "args": args}, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
                self.proc.stdin.flush()
            except OSError as e:
                with self._state:
                    self._waiter = None
                raise RuntimeError(f"{self.label} write failed: {e}") from e
            if not event.wait(self.timeout_ms / 1000.0):
                with self._state:
                    self._waiter = None
                err = TimeoutError(f"module stdio timeout after {self.timeout_ms}ms ({name})")
                self._broken = err
                self.close()  # a late reply could otherwise be delivered to the next call
                raise err
            if "error" in box:
                raise box["error"]
            try:
                msg = json.loads(box["line"])
            except ValueError as e:
                raise RuntimeError(f"module stdio '{name}' returned invalid JSON") from e
            if not isinstance(msg, dict):
                raise RuntimeError(f"module stdio '{name}' returned no output object")
            if msg.get("error") is not None:
                raise RuntimeError(str(msg["error"]))
            out = msg.get("output")
            if not isinstance(out, dict):
                raise RuntimeError(f"module stdio '{name}' returned no output object")
            return out

    def close(self) -> None:
        self._closed = True
        _LIVE.discard(self)
        try:
            if self.proc.poll() is None:
                self.proc.kill()
            self.proc.wait(timeout=5)
        except Exception:  # pragma: no cover - best effort
            pass
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                if stream is not None:
                    stream.close()
            except Exception:  # pragma: no cover
                pass


# --------------------------------------------------------------------------
# handlers
# --------------------------------------------------------------------------


def create_module_handlers(
    deployment: dict[str, Any],
    *,
    harness_dir: str | Path,
    deployment_path: str | Path | None = None,
    spawn_policy: dict[str, Any] | None = None,
) -> tuple[dict[str, ToolHandler], dict[str, str], Callable[[], None]]:
    """Build handlers for ``module.*`` natives → ``(handlers, native_to_tool, cleanup)``."""
    handlers: dict[str, ToolHandler] = {}
    native_to_tool: dict[str, str] = {}
    sessions: dict[str, ModuleStdioSession] = {}
    recorded_cache: dict[str, list[dict[str, Any]]] = {}
    recorded_used: dict[str, set[int]] = {}
    module_cfg = deployment.get("module") if isinstance(deployment.get("module"), dict) else {}
    root = str(Path(harness_dir).resolve())
    policy = dict(spawn_policy if spawn_policy is not None else spawn_policy_from_env())
    policy.setdefault("provenance", bundle_provenance_for(deployment_path or harness_dir))

    for tool_id, binding in (deployment.get("bindings") or {}).items():
        native = binding.get("native") if isinstance(binding, dict) else None
        if not isinstance(native, str):
            continue
        parsed = parse_module_native(native)
        if parsed is None:
            continue
        server_id, mapped = parsed
        if mapped != tool_id:
            raise AdapterError(
                "adapter_unresolved",
                f"adapter failure: module native '{native}' tool id must match binding key '{tool_id}'",
            )
        native_to_tool[native] = tool_id
        cfg = module_cfg.get(server_id) if server_id in module_cfg else None
        if not isinstance(cfg, dict):
            raise AdapterError(
                "adapter_unresolved", f"adapter failure: no deployment.module.{server_id} for native '{native}'"
            )
        transport = cfg.get("transport")

        if transport == "recorded":
            rec_path = cfg.get("recorded")
            if not rec_path:
                raise AdapterError(
                    "adapter_unresolved",
                    f"adapter failure: module.{server_id} recorded transport requires recorded path",
                )

            def make_recorded(sid: str = server_id, rpath: str = rec_path, tid: str = tool_id) -> ToolHandler:
                def handler(args: dict[str, Any], _ctx: dict[str, Any]) -> dict[str, Any]:
                    if sid not in recorded_cache:
                        recorded_cache[sid] = load_recorded_entries(root, rpath, "module")
                        recorded_used[sid] = set()
                    result = match_recorded_exact(recorded_cache[sid], tid, args, recorded_used[sid], "module")
                    out = result.get("output")
                    if isinstance(out, dict):
                        return result
                    return {"output": result}

                return handler

            handlers[tool_id] = make_recorded()
            continue

        if transport == "stdio":
            command = cfg.get("command")
            if not isinstance(command, str) or not command:
                raise AdapterError(
                    "adapter_unresolved", f"adapter failure: module.{server_id} stdio transport requires command"
                )
            env = cfg.get("env")
            if env is not None and not isinstance(env, dict):
                raise AdapterError("adapter_unresolved", f"adapter failure: module.{server_id} env must be an object")
            passthrough = cfg.get("env_passthrough")
            if passthrough is not None and not isinstance(passthrough, list):
                raise AdapterError(
                    "adapter_unresolved",
                    f"adapter failure: module.{server_id} env_passthrough must be a list of names",
                )
            assert_no_secret_env_names([*(env or {}).keys(), *(passthrough or [])], "module")
            args = list(cfg.get("args") or [])
            timeout_ms = int(cfg.get("timeout_ms") or 15_000)

            def make_stdio(
                sid: str = server_id,
                cmd: str = command,
                cmd_args: list[str] = args,
                env_map: dict[str, str] | None = env,
                env_pass: list[str] | None = passthrough,
                timeout: int = timeout_ms,
                tid: str = tool_id,
            ) -> ToolHandler:
                def handler(call_args: dict[str, Any], _ctx: dict[str, Any]) -> dict[str, Any]:
                    session = sessions.get(sid)
                    if session is not None and session.closed:
                        sessions.pop(sid, None)
                        session = None
                    if session is None:
                        assert_spawn_allowed(cmd, policy, "module stdio")
                        try:
                            session = ModuleStdioSession(
                                cmd,
                                cmd_args,
                                env=env_map,
                                env_passthrough=env_pass,
                                cwd=root,
                                timeout_ms=timeout,
                                label=f"module server '{sid}'",
                            )
                        except OSError as e:
                            raise AdapterError(
                                "host_session_failed", f"adapter failure: module stdio spawn failed: {e}"
                            ) from e
                        sessions[sid] = session
                    try:
                        return {"output": session.call_tool(tid, call_args)}
                    except Exception as e:  # noqa: BLE001 - surfaced as tool_execution_failed
                        raise AdapterError("host_session_failed", f"adapter failure: module call failed: {e}") from e

                return handler

            handlers[tool_id] = make_stdio()
            continue

        raise AdapterError(
            "adapter_unresolved",
            f"adapter failure: unsupported module transport '{'undefined' if transport is None else transport}'",
        )

    def cleanup() -> None:
        for s in list(sessions.values()):
            s.close()
        sessions.clear()

    return handlers, native_to_tool, cleanup
