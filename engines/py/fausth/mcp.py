"""MCP host adapters: recorded (Track A) and stdio (live) transports."""
from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable

from .adapter_error import AdapterError
from .canonical import canonical_json

SECRET_KEY_RE = re.compile(r"(api[_-]?key|secret|password|token|credential|authorization)", re.I)

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


def _load_recorded(harness_dir: Path, rel_path: str) -> list[dict[str, Any]]:
    abs_path = (harness_dir / rel_path).resolve()
    if not abs_path.is_file():
        raise AdapterError(
            "adapter_unresolved",
            f"adapter failure: mcp recorded file not found: {rel_path}",
        )
    entries: list[dict[str, Any]] = []
    for line in abs_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        row = json.loads(line)
        if not isinstance(row, dict) or not isinstance(row.get("tool"), str) or not isinstance(
            row.get("result"), dict
        ):
            raise AdapterError(
                "adapter_unresolved",
                f"adapter failure: invalid mcp recorded line in {rel_path}",
            )
        entries.append(row)
    return entries


def _match_recorded(
    entries: list[dict[str, Any]],
    tool: str,
    args: dict[str, Any],
    used: set[int],
) -> dict[str, Any]:
    args_canon = canonical_json(args or {})
    for i, e in enumerate(entries):
        if i in used or e["tool"] != tool:
            continue
        if canonical_json(e.get("args") or {}) == args_canon:
            used.add(i)
            return e["result"]
    for i, e in enumerate(entries):
        if i in used or e["tool"] != tool:
            continue
        used.add(i)
        return e["result"]
    raise AdapterError(
        "adapter_unresolved",
        f"adapter failure: no recorded mcp response for tool '{tool}'",
    )


def _assert_no_secret_env(env: dict[str, str] | None) -> None:
    if not env:
        return
    for k in env:
        if SECRET_KEY_RE.search(k):
            raise AdapterError(
                "adapter_unresolved",
                f"adapter failure: forbidden secret-like mcp env key '{k}'",
            )


class _StdioMcpSession:
    def __init__(
        self,
        command: str,
        args: list[str],
        env: dict[str, str] | None,
        timeout_ms: int,
    ) -> None:
        self.timeout_s = timeout_ms / 1000.0
        self._next_id = 1
        self._pending: dict[int, tuple[threading.Event, dict[str, Any]]] = {}
        merged_env = {**os.environ, **(env or {})}
        self.proc = subprocess.Popen(
            [command, *args],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=merged_env,
            bufsize=1,
        )
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    def _read_loop(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            mid = msg.get("id")
            if isinstance(mid, int) and mid in self._pending:
                event, box = self._pending[mid]
                box["msg"] = msg
                event.set()

    def _request(self, method: str, params: Any = None) -> Any:
        assert self.proc.stdin is not None
        rid = self._next_id
        self._next_id += 1
        event = threading.Event()
        box: dict[str, Any] = {}
        self._pending[rid] = (event, box)
        payload = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            payload["params"] = params
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()
        if not event.wait(self.timeout_s):
            self._pending.pop(rid, None)
            raise TimeoutError(f"mcp stdio timeout after {self.timeout_s}s ({method})")
        self._pending.pop(rid, None)
        msg = box.get("msg") or {}
        if "error" in msg:
            raise RuntimeError(str(msg["error"].get("message", msg["error"])))
        return msg.get("result")

    def initialize(self) -> None:
        self._request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "fausth", "version": "0.1.2-alpha"},
            },
        )
        assert self.proc.stdin is not None
        self.proc.stdin.write(
            json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n"
        )
        self.proc.stdin.flush()

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
                            return {"text": text}
        raise RuntimeError(f"mcp tools/call '{name}' returned no structured result")

    def close(self) -> None:
        try:
            self.proc.kill()
        except Exception:
            pass


def create_mcp_handlers(
    deployment: dict[str, Any],
    *,
    harness_dir: str | Path,
    mcp_tool_map: dict[str, str] | None = None,
) -> tuple[dict[str, ToolHandler], dict[str, str], Callable[[], None]]:
    handlers: dict[str, ToolHandler] = {}
    native_to_tool: dict[str, str] = {}
    sessions: dict[str, _StdioMcpSession] = {}
    recorded_cache: dict[str, list[dict[str, Any]]] = {}
    recorded_used: dict[str, set[int]] = {}
    mcp_cfg = deployment.get("mcp") or {}
    tool_map = mcp_tool_map or {}
    root = Path(harness_dir).resolve()

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
        server = mcp_cfg.get(server_id)
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
                    result = _match_recorded(
                        recorded_cache[sid], rname, args, recorded_used[sid]
                    )
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
            _assert_no_secret_env(env)
            timeout_ms = int(server.get("timeout_ms") or 15_000)
            args = list(server.get("args") or [])

            def make_stdio(
                sid: str = server_id,
                cmd: str = command,
                cmd_args: list[str] = args,
                env_map: dict[str, str] | None = env,
                timeout: int = timeout_ms,
                rname: str = remote_name,
            ) -> ToolHandler:
                def handler(call_args: dict[str, Any], _ctx: dict[str, Any]) -> dict[str, Any]:
                    session = sessions.get(sid)
                    if session is None:
                        session = _StdioMcpSession(cmd, cmd_args, env_map, timeout)
                        sessions[sid] = session
                        try:
                            session.initialize()
                        except Exception as e:
                            session.close()
                            sessions.pop(sid, None)
                            raise AdapterError(
                                "adapter_unresolved",
                                f"adapter failure: mcp stdio initialize failed: {e}",
                            ) from e
                    try:
                        result = session.call_tool(rname, call_args)
                        return {"output": result}
                    except AdapterError:
                        raise
                    except Exception as e:
                        raise AdapterError(
                            "adapter_unresolved",
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
        for s in sessions.values():
            s.close()
        sessions.clear()

    return handlers, native_to_tool, cleanup
