"""Counterbalance runtime — Python twin of ``engines/ts/src/runtime.ts``.

Values follow JavaScript semantics wherever they can reach the event log
(``??``, truthiness, ``String()``/``Number()``, ``undefined`` vs ``null``) so
that both engines emit byte-identical canonical event logs.
"""
from __future__ import annotations

import copy
import hashlib
import math
import re
from pathlib import Path
from typing import Any, Callable, Iterable

from .canonical import (
    UNDEFINED,
    canonical_json,
    deep_eq,
    is_canonical,
    is_js_integer,
    is_nullish,
    jget,
    js_keys,
    js_number,
    js_string,
    js_trim,
    js_truthy,
    jsonl_lines,
    nn,
    read_jsonl,
    state_hash,
)
from .deny_failure import (
    build_checkpoint_key_failure,
    build_missing_prior_any_of_failure,
    build_missing_prior_tools_failure,
    build_predicate_failure,
)
from .predicates import eval_predicate
from .schema_validate import validate_against_schema

ToolHandler = Callable[[Any, dict[str, Any]], Any]
ProposeFn = Callable[[], Any]

SKILLS_REFLECTION_TOOLS = frozenset(
    {"harness.propose_skills_patch", "harness.decline_skills_patch", "harness.reflect_skills"}
)


class JSTypeError(TypeError):
    """A JavaScript ``TypeError`` raised by the TS engine at the same point."""


# --------------------------------------------------------------------------
# JS value helpers used by the runtime
# --------------------------------------------------------------------------


def jprop(obj: Any, key: str) -> Any:
    """``obj.key`` — throws like V8 on ``null`` / ``undefined``."""
    if obj is UNDEFINED or obj is None:
        kind = "undefined" if obj is UNDEFINED else "null"
        raise JSTypeError(f"Cannot read properties of {kind} (reading '{key}')")
    return jget(obj, key)


def js_strict_eq(a: Any, b: Any) -> bool:
    """``a === b`` for JSON-like values (objects compare by identity)."""
    if a is b:
        return True
    if isinstance(a, bool) or isinstance(b, bool):
        return False
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    if isinstance(a, str) and isinstance(b, str):
        return a == b
    return False


def js_object_keys(v: Any) -> list[str]:
    """``Object.keys(v)`` for JSON-like values (``v`` already non-nullish)."""
    if isinstance(v, dict):
        return js_keys(v)
    if isinstance(v, (list, str)):
        return [str(i) for i in range(len(v))]
    return []


def js_object_entries(v: Any) -> list[tuple[str, Any]]:
    if isinstance(v, dict):
        return [(k, v[k]) for k in js_keys(v)]
    if isinstance(v, (list, str)):
        return [(str(i), x) for i, x in enumerate(v)]
    return []


def js_spread(v: Any) -> dict[str, Any]:
    """``{ ...v }``."""
    return dict(js_object_entries(v)) if not is_nullish(v) else {}


def js_includes(container: Any, item: Any) -> bool:
    """``container.includes(item)`` for arrays (SameValueZero) and strings."""
    if isinstance(container, (list, tuple)):
        return any(js_strict_eq(x, item) or (_is_nan(x) and _is_nan(item)) for x in container)
    if isinstance(container, str):
        return js_string(item) in container
    raise JSTypeError(f"{_js_typeof(container)}.includes is not a function")


def _is_nan(v: Any) -> bool:
    return isinstance(v, float) and math.isnan(v)


def _js_typeof(v: Any) -> str:
    if v is UNDEFINED:
        return "undefined"
    if v is None or isinstance(v, (dict, list)):
        return "object"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str):
        return "string"
    return "object"


def js_iter(v: Any, what: str) -> Iterable[Any]:
    """``for (const x of v)`` — arrays and strings are iterable, others throw."""
    if isinstance(v, (list, tuple, str)):
        return v
    raise JSTypeError(f"{what} is not iterable")


def js_array(v: Any, what: str) -> list[Any]:
    """Receiver of ``Array.prototype`` methods (``.filter``/``.some``/``.map``)."""
    if isinstance(v, (list, tuple)):
        return list(v)
    raise JSTypeError(f"{what}.filter is not a function")


def js_lt(a: Any, b: Any) -> bool:
    na = a if isinstance(a, (int, float)) and not isinstance(a, bool) else js_number(a)
    nb = b if isinstance(b, (int, float)) and not isinstance(b, bool) else js_number(b)
    if _is_nan(na) or _is_nan(nb):
        return False
    return na < nb


def js_max(a: float | int, b: float | int) -> float | int:
    """``Math.max`` (NaN-propagating)."""
    if _is_nan(a) or _is_nan(b):
        return math.nan
    return a if a >= b else b


def js_ge(a: float | int, b: Any) -> bool:
    """``a >= b`` where ``a`` is a number (relational comparison with ToNumber)."""
    nb = b if is_js_integer(b) or isinstance(b, float) else js_number(b)
    if _is_nan(nb):
        return False
    return a >= nb


def js_gt(a: Any, b: Any) -> bool:
    na = a if isinstance(a, (int, float)) and not isinstance(a, bool) else js_number(a)
    nb = b if isinstance(b, (int, float)) and not isinstance(b, bool) else js_number(b)
    if _is_nan(na) or _is_nan(nb):
        return False
    return na > nb


def js_sorted_strings(items: Iterable[Any]) -> list[Any]:
    """``Array.prototype.sort()`` default comparator (string order, undefined last).

    Strings compare by code point (D1) — identical to UTF-16 order for the BMP.
    """
    items = list(items)
    present = [x for x in items if x is not UNDEFINED]
    missing = [x for x in items if x is UNDEFINED]
    return sorted(present, key=js_string) + missing


def _set_has(done: set[str], t: Any) -> bool:
    """``Set.prototype.has`` (never raises on unhashable values)."""
    return isinstance(t, str) and t in done


def fallback_state_of(agent: dict[str, Any]) -> Any:
    return nn(agent.get("fallback_state"), agent.get("safe_state", UNDEFINED))


def normalize_envelope(raw: Any) -> dict[str, Any]:
    """TS ``normalizeEnvelope``: keep ``{output: object|array|null, …}`` as is."""
    if isinstance(raw, dict):
        if "output" in raw and (raw["output"] is None or isinstance(raw["output"], (dict, list))):
            return raw
        if "_state_patch" in raw:
            raise RuntimeError("_state_patch is forbidden; use state_transition")
    return {"output": raw}


# --------------------------------------------------------------------------
# D7 — filesystem paths and scopes (TS adapters/sandbox-path.ts, lexical part)
# --------------------------------------------------------------------------

#: Canonical root marker used for explicit whole-worktree grants.
ROOT_SCOPE = "."
_EXPLICIT_ROOT_SPELLINGS = frozenset({".", "./", "*", "**"})
_DRIVE = re.compile(r"[a-zA-Z]:")


class SandboxPathError(ValueError):
    """A path or scope outside the portable D7 rules (closed ``code`` set)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def normalize_tool_path(rel: Any) -> str:
    """Normalize a tool-supplied relative path. ``"."`` is the root.

    Rejects empty paths, NUL, absolute / drive paths, any ``..`` component and
    ``.git`` components.
    """
    if not isinstance(rel, str) or len(rel) == 0:
        raise SandboxPathError("path_invalid", "path must be a non-empty relative string")
    if "\0" in rel:
        raise SandboxPathError("path_invalid", "path contains NUL")
    unified = rel.replace("\\", "/")
    if unified.startswith("/") or _DRIVE.match(unified):
        raise SandboxPathError("path_escape", "absolute paths are forbidden")
    parts: list[str] = []
    for part in unified.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            raise SandboxPathError("path_escape", "path traversal ('..') is forbidden")
        if part.lower() == ".git":
            raise SandboxPathError("path_escape", ".git paths are forbidden")
        parts.append(part)
    return "/".join(parts) if parts else ROOT_SCOPE


def _posix_normalize_relative(p: str) -> str:
    """Node ``path.posix.normalize`` for a non-empty relative path."""
    trailing = p.endswith("/")
    res: list[str] = []
    for seg in p.split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            if res and res[-1] != "..":
                res.pop()
            else:
                res.append("..")
            continue
        res.append(seg)
    out = "/".join(res)
    if not out:
        return "./" if trailing else "."
    return out + "/" if trailing else out


def normalize_scope(raw: Any) -> str:
    """Normalize a declared scope. ``.``/``./``/``*``/``**`` are explicit root grants;
    any other spelling of the root (``src/..``, ``""``), absolute scopes and ``..``
    escapes are rejected. ``src`` ≡ ``src/`` ≡ ``./src//``."""
    if not isinstance(raw, str):
        raise SandboxPathError("path_invalid", "scope must be a string")
    unified = js_trim(raw.replace("\\", "/"))
    if unified in _EXPLICIT_ROOT_SPELLINGS:
        return ROOT_SCOPE
    if not unified or "\0" in unified:
        raise SandboxPathError("path_invalid", f"invalid scope '{raw}'")
    if unified.startswith("/") or _DRIVE.match(unified):
        raise SandboxPathError("path_escape", f"absolute scope '{raw}' is forbidden")
    norm = _posix_normalize_relative(unified).rstrip("/")
    if norm in ("", "."):
        raise SandboxPathError(
            "path_invalid", f"scope '{raw}' resolves to the worktree root; grant root explicitly as '.'"
        )
    if norm == ".." or norm.startswith("../"):
        raise SandboxPathError("path_escape", f"scope '{raw}' escapes the worktree")
    if any(part.lower() == ".git" for part in norm.split("/")):
        raise SandboxPathError("path_escape", f"scope '{raw}' targets .git")
    return norm


def normalize_scopes(raw: Iterable[Any]) -> list[str]:
    """Normalize and de-duplicate (order kept); raises on the first invalid scope."""
    out: list[str] = []
    for r in raw:
        n = normalize_scope(r)
        if n not in out:
            out.append(n)
    return out


def scope_covered(child: Any, scopes: Iterable[Any]) -> bool:
    """Segment-wise containment (D7): ``child`` is covered when some scope is the root
    grant, equals the child, or is a whole-segment prefix of it."""
    try:
        c = normalize_tool_path(child)
    except SandboxPathError:
        return False
    for raw in scopes:
        try:
            s = normalize_scope(raw)
        except SandboxPathError:
            continue
        if s == ROOT_SCOPE:
            return True
        if c == ROOT_SCOPE:
            continue
        if c == s or c.startswith(s + "/"):
            return True
    return False


def path_listed(rel: str, entries: Iterable[str]) -> bool:
    """``rel`` equals an entry or lies under a directory entry ending in ``/``."""
    for e in entries:
        if e.endswith("/"):
            if rel == e[:-1] or rel.startswith(e):
                return True
        elif rel == e:
            return True
    return False


def parse_recorded_model_line(line: Any) -> dict[str, Any]:
    """TS ``parseRecordedModelLine`` (``adapters/recorded.ts``)."""
    if not isinstance(line, dict):
        if line is None:
            raise JSTypeError("Cannot read properties of null (reading 'type')")
        raise ValueError(f"Invalid model.jsonl entry: {canonical_safe(line)}")
    if line.get("type") == "stop":
        return {"type": "stop", "message": line.get("message", UNDEFINED)}
    if line.get("type") == "invalid":
        out = {"type": "invalid", "reason": line["reason"] if isinstance(line.get("reason"), str) else "invalid"}
        if isinstance(line.get("message"), str):
            out["message"] = line["message"]
        return out
    if line.get("type") == "tool" or isinstance(line.get("name"), str):
        return {
            "type": "tool",
            "name": js_string(nn(line.get("name", UNDEFINED), line.get("tool", UNDEFINED))),
            "args": nn(line.get("args", UNDEFINED), {}),
        }
    raise ValueError(f"Invalid model.jsonl entry: {canonical_safe(line)}")


def canonical_safe(v: Any) -> str:
    from .canonical import js_json_stringify

    return js_json_stringify(v)


def _is_stale_value(v: Any) -> bool:
    """``v === 0 || v === null || v === undefined || v === ""``."""
    if v is None or v is UNDEFINED:
        return True
    if isinstance(v, bool):
        return False
    if isinstance(v, (int, float)):
        return v == 0
    return isinstance(v, str) and v == ""


# --------------------------------------------------------------------------
# Runtime
# --------------------------------------------------------------------------


from .engine import FaustRuntime  # noqa: E402  (the v0.3 engine; see engine.py)


def jprop_args(action: dict[str, Any]) -> Any:
    """``action.args`` dereferenced for a property read (throws on null/undefined)."""
    args = action["args"]
    if args is UNDEFINED or args is None:
        jprop(args, "set")
    return args


from .engine import events_to_jsonl  # noqa: E402,F811

# Worlds — TS ``tools/world.ts`` (+ ``adapters/simulation.ts``)
#
# Same policy as the TS local adapter (EDGE-20): paths/scopes normalized (D7),
# absent read scopes = unrestricted, absent write scopes = no writes, secrets
# and protected paths initialised, the shell restores protected files and sets
# test evidence on exit 0 — only the I/O is simulated.
# --------------------------------------------------------------------------

SHELL_NOT_ALLOWLISTED_ERROR = (
    "not allowlisted: only 'test' and 'typecheck' are available; use fs.read/fs.list to explore"
)
GREET_HELLO = 'export function greet(){ return "hello"; }\n'
SECRET_FIXTURE_VALUE = "sk-fixture-secret-0001"
#: Host control directory: never writable by the agent in any world.
HOST_CONTROL_DIR = ".fausth"
#: Files every simulated coding world starts with (merged under explicit files).
SIM_DEFAULT_FILES: dict[str, str] = {"src/app.ts": "export {}"}


def _utf8(s: str) -> bytes:
    return s.encode("utf-8", errors="surrogatepass")


def content_fingerprint(content: str | None) -> str:
    if content is None:
        return "missing"
    return hashlib.sha256(_utf8(content)).hexdigest()


def create_greenhouse_tools(world: dict[str, Any]) -> dict[str, ToolHandler]:
    def temp_read(args: Any, ctx: dict[str, Any]) -> dict[str, Any]:
        return {"output": {"celsius_decidegrees": world["temperature_decidegrees"]}}

    def fan_read(args: Any, ctx: dict[str, Any]) -> dict[str, Any]:
        return {"output": {"percent": world["fan_percent"]}}

    def fan_set(args: Any, ctx: dict[str, Any]) -> dict[str, Any]:
        percent = js_number(jprop(args, "percent"))
        world["fan_percent"] = percent
        return {"output": {"ok": 1, "percent": percent}, "state_transition": {"set": {"fan_percent": percent}}}

    def wait(args: Any, ctx: dict[str, Any]) -> dict[str, Any]:
        return {"output": {"waited_ms": js_number(nn(jprop(args, "ms"), 0))}}

    return {
        "sensor.temperature.read": temp_read,
        "sensor.fan.read_percent": fan_read,
        "actuator.fan.set": fan_set,
        "system.wait": wait,
    }


def _normalize_world_path(raw: str) -> tuple[bool, str]:
    """``(True, normalized)`` or ``(False, error code)`` — TS world ``normalizePath``."""
    try:
        return True, normalize_tool_path(raw)
    except SandboxPathError as e:
        return False, e.code


def _list_entries_in_memory(path: str, files: dict[str, str]) -> list[str]:
    root = path == ROOT_SCOPE
    prefix = "" if root else f"{path}/"
    entries: set[str] = set()
    for key in files:
        if not root and not key.startswith(prefix):
            continue
        name = key[len(prefix):].split("/")[0]
        if name:
            entries.add(name)
    return sorted(entries)


def _read_allowed(world: dict[str, Any], path: str) -> bool:
    scopes = world.get("read_scopes")
    if scopes is None:
        return True
    return scope_covered(path, scopes)


def _register_secret_value(world: dict[str, Any], raw: str) -> None:
    v = js_trim(raw)
    if not v:
        return
    world.setdefault("secret_values", [])
    if v not in world["secret_values"]:
        world["secret_values"].append(v)


def _secrets_active(world: dict[str, Any]) -> bool:
    return bool(world.get("secret_paths")) or bool(world.get("secret_values"))


def _should_deny_write_contains(world: dict[str, Any]) -> bool:
    if not _secrets_active(world):
        return False
    return world.get("deny_write_contains") is not False


def _content_has_secret(world: dict[str, Any], content: str) -> bool:
    return any(s and s in content for s in world.get("secret_values") or [])


def _protection_active(world: dict[str, Any]) -> bool:
    return bool(world.get("protected_paths"))


def _protect_flags(world: dict[str, Any]) -> dict[str, int]:
    return {"protected_modified": 0} if _protection_active(world) else {}


def restore_protected_paths(world: dict[str, Any]) -> bool:
    baseline_map = world.get("protected_baseline")
    if not _protection_active(world) or baseline_map is None:
        return False
    drifted = False
    for p in world["protected_paths"]:
        baseline = baseline_map.get(p)
        current = world["files"].get(p)
        if content_fingerprint(current) != content_fingerprint(baseline):
            drifted = True
            if baseline is None:
                world["files"].pop(p, None)
            else:
                world["files"][p] = baseline
    return drifted


def _normalize_declared(paths: Any) -> list[str]:
    out: list[str] = []
    for p in nn(paths, []):
        ok, n = _normalize_world_path(js_string(p))
        if ok:
            out.append(n)
    return out


def init_coding_secrets(world: dict[str, Any], secrets: Any) -> None:
    if not js_truthy(secrets):
        return
    world["secret_paths"] = _normalize_declared(jget(secrets, "paths"))
    world["deny_write_contains"] = jget(secrets, "deny_write_contains") is not False
    world.setdefault("secret_values", [])
    for v in nn(jget(secrets, "values"), []):
        _register_secret_value(world, js_string(v))
    for p in world["secret_paths"]:
        if p in world["files"]:
            _register_secret_value(world, world["files"][p])


def init_coding_protected_paths(world: dict[str, Any], paths: Any) -> None:
    if not js_truthy(paths) or len(paths) == 0:
        return
    world["protected_paths"] = _normalize_declared(paths)
    world["protected_baseline"] = {p: world["files"].get(p) for p in world["protected_paths"]}


def coding_world_from_agent(
    agent: dict[str, Any],
    *,
    test_exit: int | None = None,
    files: dict[str, str] | None = None,
    exit_codes: dict[str, int] | None = None,
) -> dict[str, Any]:
    """TS ``codingWorldFromAgent``: absent write scopes = no writes, absent read scopes =
    unrestricted reads, secrets + protected paths initialised (scopes normalized, D7)."""
    perms = agent.get("permissions", UNDEFINED)
    fs = jget(perms, "filesystem")
    write_scopes = jget(fs, "write_scopes")
    read_scopes = jget(fs, "read_scopes")
    world: dict[str, Any] = {
        "files": files
        if files is not None
        else {"src/app.ts": "export {}", "src/app.js": 'export function greet(){ return "hi"; }\n'},
        "write_scopes": normalize_scopes(write_scopes) if js_truthy(write_scopes) else [],
        "read_scopes": normalize_scopes(read_scopes) if js_truthy(read_scopes) else None,
        "last_exit_code": nn(test_exit, 1),
        "out_of_scope_writes": 0,
    }
    if exit_codes is not None:
        world["exit_codes"] = dict(exit_codes)
    init_coding_secrets(world, jget(perms, "secrets"))
    init_coding_protected_paths(world, jget(perms, "protected_paths"))
    return world


def create_coding_tools(world: dict[str, Any] | None = None) -> dict[str, ToolHandler]:
    if world is None:
        world = coding_world_from_agent({"permissions": {"filesystem": {"write_scopes": ["src/"]}}}, test_exit=0)

    def fs_read(args: Any, ctx: dict[str, Any]) -> dict[str, Any]:
        raw = js_string(jprop(args, "path"))
        ok, path = _normalize_world_path(raw)
        if not ok:
            return {"output": {"path": raw, "content": "", "found": 0, "error": path}}
        if not _read_allowed(world, path):
            return {"output": {"path": path, "content": "", "found": 0, "error": "scope_denied"}}
        found = 1 if path in world["files"] else 0
        content = world["files"][path] if found else ""
        if found and world.get("secret_paths") and path_listed(path, world["secret_paths"]):
            _register_secret_value(world, content)
        return {"output": {"path": path, "content": content, "found": found}}

    def fs_list(args: Any, ctx: dict[str, Any]) -> dict[str, Any]:
        raw = js_string(jprop(args, "path"))
        ok, path = _normalize_world_path(raw)
        if not ok:
            return {"output": {"path": raw, "entries": [], "found": 0, "error": path}}
        if not _read_allowed(world, path):
            return {"output": {"path": path, "entries": [], "found": 0, "error": "scope_denied"}}
        entries = _list_entries_in_memory(path, world["files"])
        return {"output": {"path": path, "entries": entries, "found": 1 if entries else 0}}

    def fs_write(args: Any, ctx: dict[str, Any]) -> dict[str, Any]:
        raw = js_string(jprop(args, "path"))
        content = js_string(nn(jprop(args, "content"), ""))
        leak_check = _should_deny_write_contains(world)
        ok, norm = _normalize_world_path(raw)
        path = norm if ok else raw
        host_reserved = ok and (path == HOST_CONTROL_DIR or path.startswith(f"{HOST_CONTROL_DIR}/"))
        allowed = ok and path != ROOT_SCOPE and not host_reserved and scope_covered(path, world["write_scopes"])
        # Every check happens before the write (same order as the local adapter).
        if not allowed:
            world["out_of_scope_writes"] += 1
            error = norm if not ok else "host_reserved" if host_reserved else "path_invalid" if path == ROOT_SCOPE else None
            out: dict[str, Any] = {"ok": 0, "out_of_scope": 1, "path": path}
            if error:
                out["error"] = error
            if leak_check:
                out["secret_leak"] = 0
            out.update(_protect_flags(world))
            return {"output": out, "state_transition": {"set": {"out_of_scope_writes": world["out_of_scope_writes"]}}}
        if _protection_active(world) and path_listed(path, world["protected_paths"]):
            out_p: dict[str, Any] = {"ok": 0, "out_of_scope": 0, "protected_modified": 1, "path": path}
            if leak_check:
                out_p["secret_leak"] = 0
            return {"output": out_p}
        if leak_check and _content_has_secret(world, content):
            out_l: dict[str, Any] = {"ok": 0, "out_of_scope": 0, "secret_leak": 1, "path": path}
            out_l.update(_protect_flags(world))
            return {"output": out_l}
        world["files"][path] = content
        out_ok: dict[str, Any] = {"ok": 1, "out_of_scope": 0, "path": path}
        if leak_check:
            out_ok["secret_leak"] = 0
        out_ok.update(_protect_flags(world))
        return {"output": out_ok}

    def shell(args: Any, ctx: dict[str, Any]) -> dict[str, Any]:
        cmd = js_string(jprop(args, "cmd"))
        protect = _protection_active(world)
        codes = world.get("exit_codes")
        scripted = isinstance(codes, dict) and cmd in codes
        if scripted or cmd in ("test", "typecheck"):
            code = codes[cmd] if scripted else world["last_exit_code"]
            if restore_protected_paths(world):
                return {"output": {"exit_code": code, "cmd": cmd, "protected_modified": 1}}
            out: dict[str, Any] = {"exit_code": code, "cmd": cmd}
            if protect:
                out["protected_modified"] = 0
            # Test evidence is the IR's declared effect on exit_code 0 (D11), not a world write.
            return {"output": out}
        out_deny: dict[str, Any] = {"exit_code": 1, "cmd": cmd, "error": SHELL_NOT_ALLOWLISTED_ERROR}
        if protect:
            out_deny["protected_modified"] = 0
        return {"output": out_deny}

    def kb_lookup(args: Any, ctx: dict[str, Any]) -> dict[str, Any]:
        # D2: truncation counts code points.
        query = js_string(nn(jprop(args, "query"), "x"))[:24]
        return {"output": {"ok": 1, "article_id": f"kb-{query}"}}

    def reflect(args: Any, ctx: dict[str, Any]) -> dict[str, Any]:
        if jprop(args, "disposition") == "propose":
            return {"output": {"ok": 1, "disposition": "propose", "proposed": 1}}
        return {"output": {"ok": 1, "disposition": "decline", "declined": 1}}

    def echo(args: Any, ctx: dict[str, Any]) -> dict[str, Any]:
        return {"output": {"ok": 1, "echo": js_string(nn(jprop(args, "message"), "pong"))}}

    # D14/D11: no user-cell handlers here and no state written by name — declared tool effects
    # in the IR say what a result means for state (spec-v0.3 §6.3).
    return {
        "fs.read": fs_read,
        "fs.list": fs_list,
        "fs.write_scoped": fs_write,
        "shell.run_allowlisted": shell,
        "task.complete": lambda a, c: {"output": {"ok": 1}},
        "phase.yield": lambda a, c: {"output": {"ok": 1}},
        "kb.lookup": kb_lookup,
        "answer.send": lambda a, c: {"output": {"ok": 1}},
        "human.handoff": lambda a, c: {"output": {"ok": 1}},
        "refund.request": lambda a, c: {"output": {"ok": 1}},
        "harness.propose_skills_patch": lambda a, c: {"output": {"ok": 1, "proposed": 1}},
        "harness.decline_skills_patch": lambda a, c: {"output": {"ok": 1, "declined": 1}},
        "harness.reflect_skills": reflect,
        "echo.ping": echo,
    }


def create_spawn_tool() -> dict[str, ToolHandler]:
    def spawn(args: Any, ctx: dict[str, Any]) -> dict[str, Any]:
        return {"output": {"spawned": 1, "tools": nn(jprop(args, "tools"), [])}}

    return {"agent.spawn": spawn}


def _greenhouse_world(agent: dict[str, Any], sensor_healthy: Any = None) -> dict[str, Any]:
    st = agent.get("state") or {}
    return {
        "temperature_decidegrees": js_number(nn(st.get("temperature_decidegrees", UNDEFINED), 250)),
        "fan_percent": js_number(nn(st.get("fan_percent", UNDEFINED), 0)),
        "sensor_healthy": nn(sensor_healthy, js_number(nn(st.get("sensor_healthy", UNDEFINED), 1))),
    }


def default_tools(
    agent: dict[str, Any],
    *,
    test_exit: int | None = None,
    sensor_healthy: int | None = None,
) -> dict[str, ToolHandler]:
    """Replay world — TS ``cli.ts buildTools`` (fixture / Track A default world)."""
    files: dict[str, str] = {"src/app.ts": "export {}", "src/app.js": GREET_HELLO}
    perms = agent.get("permissions", UNDEFINED)
    secret_paths = jget(jget(perms, "secrets"), "paths")
    if js_truthy(secret_paths):
        for p in secret_paths:
            if p not in files:
                files[p] = SECRET_FIXTURE_VALUE
    for p in nn(jget(perms, "protected_paths"), []):
        if p not in files:
            files[p] = GREET_HELLO
    return {
        **create_greenhouse_tools(_greenhouse_world(agent, sensor_healthy)),
        **create_coding_tools(coding_world_from_agent(agent, test_exit=test_exit, files=files)),
        **create_spawn_tool(),
    }


def create_simulation_coding_tools(
    *,
    files: dict[str, str] | None = None,
    write_scopes: Any = None,
    read_scopes: Any = None,
    exit_codes: dict[str, int] | None = None,
) -> dict[str, ToolHandler]:
    """TS ``createSimulationCodingAdapter`` (deterministic fake FS/shell)."""
    world: dict[str, Any] = {
        "files": {**SIM_DEFAULT_FILES, **(files or {})},
        "write_scopes": normalize_scopes(nn(write_scopes, ["src/"])),
        "read_scopes": normalize_scopes(read_scopes) if js_truthy(read_scopes) else None,
        "last_exit_code": 0,
        "out_of_scope_writes": 0,
    }
    if exit_codes:
        world["exit_codes"] = dict(exit_codes)
    return create_coding_tools(world)


def simulation_tool_pool(
    agent: dict[str, Any],
    *,
    test_exit: int | None = None,
    sensor_healthy: int | None = None,
    files: dict[str, str] | None = None,
) -> dict[str, ToolHandler]:
    """Deployment handler pool — TS ``adapters/registry.ts buildHandlerPool``: the agent's own
    permissions on a simulated world (``createSimulationWorldForAgent``)."""
    world = coding_world_from_agent(
        agent, test_exit=nn(test_exit, 0), files={**SIM_DEFAULT_FILES, **(files or {})}
    )
    return {
        **create_greenhouse_tools(_greenhouse_world(agent, sensor_healthy)),
        **create_coding_tools(world),
        **create_spawn_tool(),
    }




# --------------------------------------------------------------------------
# Track A replay
# --------------------------------------------------------------------------


def load_fixture_agent(dir_path: Path) -> dict[str, Any]:
    """TS ``loadFixtureAgent``: raw ``agent.json`` when present, else the harness loader."""
    from .canonical import json_loads, read_text_utf8

    js = dir_path / "agent.json"
    if js.exists():
        return json_loads(read_text_utf8(js))
    from .registry import load_agent_dir

    return load_agent_dir(dir_path)


def fixture_user_channel(agent: dict[str, Any], dir_path: Path, answers_file: str = "user.jsonl") -> dict[str, Any]:
    """TS ``fixtureUserChannel``: recorded user answers for every ``channel: user`` tool."""
    from .user_channel import create_user_channel_handler, state_value_type

    out: dict[str, Any] = {}
    state = agent.get("state") or {}
    for tool in agent.get("tools") or []:
        if tool.get("channel") != "user":
            continue
        keys = [k for c in ((agent.get("counterbalance") or {}).get("checkpoints") or []) if c.get("tool") == tool.get("id") for k in c.get("allow_set_keys") or []]
        types = {k: state_value_type(state[k]) for k in keys if k in state}
        out[tool["id"]] = create_user_channel_handler(
            tool, {"source": "recorded", "answers": answers_file}, base_dir=dir_path, allow_set_keys=keys, state_types=types
        )
    return out


def build_replay_world(agent: dict[str, Any]) -> dict[str, Any]:
    """TS ``buildReplayWorld``: default world without handlers for user-channel tools."""
    user = {t.get("id") for t in agent.get("tools") or [] if t.get("channel") == "user"}
    return {k: v for k, v in default_tools(agent).items() if k not in user}


def run_fixture(dir_path: Path, agent: dict[str, Any] | None = None) -> Any:
    from .engine import FaustRuntime as EngineRuntime
    from .engine import to_proposal

    dir_path = Path(dir_path)
    agent = agent if agent is not None else load_fixture_agent(dir_path)
    proposals = [to_proposal(parse_recorded_model_line(x)) for x in read_jsonl(dir_path / "model.jsonl")]
    tools_path = dir_path / "tools.jsonl"
    transcript = read_jsonl(tools_path) if tools_path.exists() else None
    tools = build_replay_world(agent)
    if (dir_path / "user.jsonl").exists():
        tools = {**tools, **fixture_user_channel(agent, dir_path)}
    rt = EngineRuntime(agent, proposals, tools, transcript, parse_proposals=False, allow_judge=False)
    rt.run_loop()
    return rt


def replay_fixture(dir_path: Path) -> tuple[bool, str, str]:
    from .canonical import read_text_utf8
    from .engine import events_to_jsonl as engine_events_to_jsonl

    dir_path = Path(dir_path)
    rt = run_fixture(dir_path)
    actual = engine_events_to_jsonl(rt.events)
    expected = read_text_utf8(dir_path / "expected.jsonl").replace("\r\n", "\n")
    return actual == expected, actual, expected
