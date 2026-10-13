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
    if line.get("type") == "tool" or js_truthy(line.get("name")):
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


class _Pending:
    """A call's state transition, applied provisionally until its verifies pass (D8)."""

    __slots__ = ("state", "provenance", "stale", "keys")

    def __init__(self, state: dict[str, Any], provenance: Any, stale: set[str], keys: list[str]) -> None:
        self.state = state
        self.provenance = provenance
        self.stale = stale
        self.keys = keys


class FaustRuntime:
    def __init__(
        self,
        agent: dict[str, Any],
        proposals: list[Any] | ProposeFn,
        tools: dict[str, ToolHandler],
        recorded_tool_results: list[dict[str, Any]] | None = None,
        *,
        depth: int = 0,
        spawn_id: str | None = None,
        parse_proposals: bool = True,
        user_tools: Iterable[str] | None = None,
    ) -> None:
        self.agent = copy.deepcopy(agent)
        if js_truthy(self.agent.get("safe_state")) and not js_truthy(self.agent.get("fallback_state")):
            self.agent["fallback_state"] = self.agent["safe_state"]
        if callable(proposals):
            self._propose: ProposeFn = proposals
        else:
            queue = [parse_recorded_model_line(p) for p in proposals] if parse_proposals else list(proposals)
            self.proposals = queue
            self.pi = 0

            def _next() -> Any:
                if self.pi >= len(self.proposals):
                    return {"type": "stop"}
                p = self.proposals[self.pi]
                self.pi += 1
                return p

            self._propose = _next
        self.tools = tools
        #: Tools whose handler is a host user channel (D14). Defaults to what the
        #: registry bound (``ToolSet.user_tools``); world handlers never answer them.
        self.user_tools = set(user_tools if user_tools is not None else getattr(tools, "user_tools", ()) or ())
        self.recorded = recorded_tool_results or []
        self.ri = 0
        self.events: list[dict[str, Any]] = []
        self.seq = 0
        self.steps = 0
        self.tool_calls = 0
        self.recovering = False
        self.depth = depth
        self.spawn_id = spawn_id
        self.skills_propose_attempts = 0
        self.skills_decline_attempts = 0
        self.skills_reflect_attempts = 0
        #: D8: tool ids that executed AND passed every verify, in order.
        self.succeeded: list[str] = []
        #: PY-7: memory keys currently stale (memory_stale fires once per transition).
        self.stale_keys: set[str] = set()
        self._pending: _Pending | None = None

    # -- IR accessors (``this.agent.x?.y`` chains) -------------------------

    @property
    def cb(self) -> Any:
        return self.agent.get("counterbalance", UNDEFINED)

    def cb_get(self, key: str) -> Any:
        return jget(self.cb, key)

    def limits_get(self, key: str) -> Any:
        return jget(self.agent.get("limits", UNDEFINED), key)

    def perms_get(self, key: str) -> Any:
        return jget(self.agent.get("permissions", UNDEFINED), key)

    @property
    def state(self) -> dict[str, Any]:
        return self.agent["state"]

    # -- events -------------------------------------------------------------

    def emit(self, partial: dict[str, Any]) -> dict[str, Any]:
        """Append an event. ``UNDEFINED``/absent fields are omitted; ``None`` is JSON null."""
        self.seq += 1
        ev: dict[str, Any] = {
            "seq": self.seq,
            "ts_logical": self.seq,
            "state_hash": state_hash(self.agent["state"]),
            "stage": partial["stage"],
        }
        for k in ("verdict", "reason", "tool", "args", "result", "observation", "error", "failure"):
            if partial.get(k, UNDEFINED) is not UNDEFINED:
                ev[k] = partial[k]
        if self.depth > 0:
            ev["depth"] = self.depth
        if self.spawn_id:
            ev["spawn_id"] = self.spawn_id
        for k in ("depth", "spawn_id", "harness_hash_before", "harness_hash_after"):
            if partial.get(k, UNDEFINED) is not UNDEFINED:
                ev[k] = partial[k]
        self.events.append(ev)
        return ev

    def tool_by_id(self, tid: Any) -> dict[str, Any] | None:
        for t in self.agent.get("tools") or []:
            if js_strict_eq(jget(t, "id"), tid) or (tid is UNDEFINED and jget(t, "id") is UNDEFINED):
                return t
        return None

    def parent_tools(self) -> list[Any]:
        perms = self.perms_get("tools")
        if not is_nullish(perms):
            return perms
        return [jget(t, "id") for t in self.agent.get("tools") or []]

    def check_limits(self) -> bool:
        max_steps = nn(self.limits_get("max_steps"), 1000)
        max_tools = nn(self.limits_get("max_tool_calls"), 1000)
        if js_ge(self.steps, max_steps) or js_ge(self.tool_calls, max_tools):
            self.emit({"stage": "authorize", "verdict": "deny", "reason": "limit_exceeded"})
            return False
        return True

    def deny_is_terminal(self) -> bool:
        """Plain deny stops by default; opt-in continue_after_deny lets the agent recover."""
        return self.limits_get("continue_after_deny") is not True

    def eval_gates(self, snapshot: dict[str, Any]) -> tuple[bool, Any, str | None]:
        gates = self.agent.get("gates", UNDEFINED)
        if not js_truthy(gates):
            return True, None, None
        for g in js_iter(gates, "gates"):
            when = jget(g, "when")
            if js_truthy(when) and not eval_predicate(when, snapshot):
                continue
            if not eval_predicate(jprop(g, "require"), snapshot):
                return False, nn(jget(g, "otherwise"), "deny"), "gate_denied"
        return True, None, None

    def successful_executes(self) -> set[str]:
        """D8: tools that executed AND passed all verifies (this reaction only)."""
        return set(self.succeeded)

    def collect_completion_paths(self, p: Any, out: list[str] | None = None) -> list[str]:
        if out is None:
            out = []
        if not isinstance(p, (dict, list)):
            return out
        path = jget(p, "path")
        if isinstance(path, str):
            out.append(path)
        all_items = jget(p, "all")
        if isinstance(all_items, list):
            for x in all_items:
                self.collect_completion_paths(x, out)
        any_items = jget(p, "any")
        if isinstance(any_items, list):
            for x in any_items:
                self.collect_completion_paths(x, out)
        not_item = jget(p, "not")
        if js_truthy(not_item):
            self.collect_completion_paths(not_item, out)
        return out

    # -- orientation ----------------------------------------------------------

    def build_orientation_frame(self) -> dict[str, Any]:
        """Deterministic orientation snapshot. D11: only IR-declared semantics — no
        engine knowledge of plan_approved / user.approve / phase.yield / task.complete."""
        cb = nn(self.cb, {})
        # Can-only: advertise tools this harness actually declares — never blocked_tools / modes.
        permitted = js_sorted_strings([jget(t, "id") for t in self.agent.get("tools") or []])
        done = self.successful_executes()
        sequence_blockers: list[dict[str, Any]] = []
        for s in js_array(nn(jget(cb, "sequences"), []), "sequences"):
            if not js_truthy(jprop(s, "action")):
                continue
            priors = jget(s, "require_prior_tools")
            options_raw = jget(s, "require_prior_any_of")
            if not (js_gt(nn(jget(priors, "length"), 0), 0) or js_gt(nn(jget(options_raw, "length"), 0), 0)):
                continue
            missing = js_sorted_strings(
                [t for t in js_array(nn(priors, []), "require_prior_tools") if not _set_has(done, t)]
            )
            options = js_array(nn(options_raw, []), "require_prior_any_of")
            missing_any = (
                js_sorted_strings(options)
                if len(options) > 0 and not any(_set_has(done, t) for t in options)
                else []
            )
            if not missing and not missing_any:
                continue
            blocker: dict[str, Any] = {"action": jget(s, "action")}
            if missing:
                blocker["missing_prior_tools"] = missing
            if missing_any:
                blocker["missing_prior_any_of"] = missing_any
            sequence_blockers.append(blocker)
        freshness: dict[str, Any] = {}
        for rule in js_iter(nn(jget(cb, "invalidate_after"), []), "invalidate_after"):
            for key in js_iter(nn(jget(rule, "memory_keys"), []), "memory_keys"):
                freshness[js_string(key)] = js_number(nn(self.state.get(js_string(key), UNDEFINED), 0))
        frame: dict[str, Any] = {
            "permitted_tools": permitted,
            "tools": permitted,
            "sequence_blockers": sequence_blockers,
            "freshness": freshness,
        }
        ctool = self.completion_tool_id()
        if ctool is not None:
            require = jget(jget(cb, "completion"), "require")
            frame["completion"] = {
                "tool": ctool,
                "require_paths": sorted(set(self.collect_completion_paths(require))) if js_truthy(require) else [],
                "ready": 1 if self.check_completion(ctool)[0] else 0,
            }
        return frame

    # -- authorize checks -----------------------------------------------------

    def check_sequences(self, action: dict[str, Any]) -> tuple[bool, str | None, dict[str, Any] | None]:
        seqs = self.cb_get("sequences")
        if not js_truthy(seqs) or jget(seqs, "length") == 0:
            return True, None, None
        done = self.successful_executes()
        snap = {"action": action, "state": self.state}
        checkpoints = nn(self.cb_get("checkpoints"), [])
        for seq in js_iter(seqs, "sequences"):
            if not js_strict_eq(jget(seq, "action"), action["name"]):
                continue
            missing = [
                t
                for t in js_array(nn(jget(seq, "require_prior_tools"), []), "require_prior_tools")
                if not _set_has(done, t)
            ]
            if missing:
                return False, "sequence_requirement_failed", build_missing_prior_tools_failure(missing)
            any_of = nn(jget(seq, "require_prior_any_of"), [])
            if js_gt(jget(any_of, "length"), 0) and not any(
                _set_has(done, t) for t in js_array(any_of, "require_prior_any_of")
            ):
                return False, "sequence_requirement_failed", build_missing_prior_any_of_failure(any_of)
            req = jget(seq, "require_state")
            if js_truthy(req) and not eval_predicate(req, snap):
                return (
                    False,
                    "sequence_requirement_failed",
                    build_predicate_failure(req, snap, checkpoints),
                )
        return True, None, None

    def reflection_already_done(self) -> bool:
        done = self.successful_executes()
        return bool(done & SKILLS_REFLECTION_TOOLS)

    def note_reflection_attempt(self, tool: str) -> None:
        if tool == "harness.propose_skills_patch":
            self.skills_propose_attempts += 1
        if tool == "harness.decline_skills_patch":
            self.skills_decline_attempts += 1
        if tool == "harness.reflect_skills":
            self.skills_reflect_attempts += 1

    def reflection_gate(self, action_name: str) -> tuple[bool, str | None]:
        if self.reflection_already_done():
            return False, "skills reflection already completed this phase (propose XOR decline)"
        if action_name == "harness.propose_skills_patch" and self.skills_propose_attempts >= 1:
            return (
                False,
                "propose already attempted this phase; call harness.decline_skills_patch with a reason instead",
            )
        if action_name == "harness.decline_skills_patch" and self.skills_decline_attempts >= 1:
            return False, "decline already attempted this phase"
        if action_name == "harness.reflect_skills" and self.skills_reflect_attempts >= 1:
            return False, "reflect_skills already attempted this phase"
        return True, None

    # -- memory / provenance (PY-7: memory_stale once per staleness transition) --

    def _invalidate(self, keys: list[Any]) -> bool:
        """Mark keys stale (state 0). Keys already stale are left alone; True if any changed."""
        touched = False
        next_state = dict(self.state)
        for key in keys:
            k = js_string(key)
            if k in self.stale_keys:
                continue
            next_state[k] = 0
            self.stale_keys.add(k)
            self.touch_provenance_stale(k)
            touched = True
        if touched:
            self.agent["state"] = next_state
        return touched

    def apply_invalidate_after(self, action_name: str) -> None:
        rules = self.cb_get("invalidate_after")
        if not js_truthy(rules):
            return
        keys: list[Any] = []
        for rule in js_iter(rules, "invalidate_after"):
            ra = jget(rule, "action")
            if not js_truthy(ra) or not js_strict_eq(ra, action_name):
                continue
            keys.extend(js_iter(jprop(rule, "memory_keys"), "rule.memory_keys"))
        if not self._invalidate(keys):
            return
        self.emit(
            {
                "stage": "record",
                "verdict": "allow",
                "reason": "memory_stale",
                "tool": action_name,
                "result": {"invalidated": 1},
            }
        )

    def touch_provenance_stale(self, key: Any) -> None:
        """Update an existing provenance entry; never creates one (TS semantics)."""
        mp = self.cb_get("memory_provenance")
        if not isinstance(mp, dict):
            return
        k = js_string(key)
        if not js_truthy(mp.get(k, UNDEFINED)):
            return
        mp[k] = {**js_spread(mp[k]), "status": "stale", "updated_at_step": self.steps}

    def touch_provenance_fresh(self, key: str) -> None:
        cb = self.cb
        if not js_truthy(cb) or not isinstance(cb, dict):
            return
        if not js_truthy(cb.get("memory_provenance")):
            cb["memory_provenance"] = {}
        mp = cb["memory_provenance"]
        prev = nn(jget(mp, key), {})
        mp[key] = {
            **js_spread(prev),
            "status": "current",
            "updated_at_step": self.steps,
            "source": nn(jget(prev, "source"), "world"),
        }

    def apply_ttl_invalidation(self) -> None:
        rules = self.cb_get("invalidate_after")
        if not js_truthy(rules):
            return
        mp = nn(self.cb_get("memory_provenance"), {})
        expired: list[Any] = []
        for rule in js_iter(rules, "invalidate_after"):
            ttl = jget(rule, "ttl_steps")
            if js_truthy(jget(rule, "action")) or not js_truthy(ttl) or js_lt(ttl, 1):
                continue
            for key in js_iter(jprop(rule, "memory_keys"), "rule.memory_keys"):
                meta = jget(mp, js_string(key))
                updated = nn(jget(meta, "updated_at_step"), 0)
                if js_number(self.steps - js_number(updated)) < js_number(ttl):
                    continue
                expired.append(key)
        if not self._invalidate(expired):
            return
        self.emit(
            {
                "stage": "record",
                "verdict": "allow",
                "reason": "memory_stale",
                "result": {"invalidated": 1, "ttl": 1},
            }
        )

    def check_intervention_budget(self) -> None:
        budget = self.cb_get("intervention_budget")
        if not js_truthy(budget):
            return
        max_a = jget(budget, "max_activations")
        if max_a is not UNDEFINED and js_number(max_a) < 1:
            return
        if jget(budget, "window") == "host_day":
            return
        if isinstance(max_a, str) or max_a is UNDEFINED:
            return  # `steps === "3" + 1` / `NaN` never holds
        if self.steps == js_number(max_a) + 1:
            self.emit(
                {
                    "stage": "record",
                    "verdict": "allow",
                    "reason": "budget_exceeded",
                    "result": {
                        "max_activations": max_a,
                        "activations": self.steps,
                        "window": nn(jget(budget, "window"), "run"),
                    },
                }
            )

    # -- completion / checkpoints / user cell -----------------------------------

    def completion_tool_id(self) -> str | None:
        """D11: the run's terminal tool is only what the IR declares (no default)."""
        tool = jget(self.cb_get("completion"), "tool")
        return tool if isinstance(tool, str) and tool else None

    def is_terminal_success_tool(self, name: Any) -> bool:
        ctool = self.completion_tool_id()
        return ctool is not None and name == ctool

    def check_completion(self, action_name: Any) -> tuple[bool, str | None, dict[str, Any] | None]:
        completion = self.cb_get("completion")
        tool = self.completion_tool_id()
        if tool is None or not js_strict_eq(action_name, tool):
            return True, None, None
        req = jget(completion, "require")
        if not js_truthy(req):
            return True, None, None
        snap = {"action": {"name": action_name, "args": {}}, "state": self.state}
        if not eval_predicate(req, snap):
            checkpoints = nn(self.cb_get("checkpoints"), [])
            return False, "completion_gate_failed", build_predicate_failure(req, snap, checkpoints)
        return True, None, None

    def _checkpoint_policy(self, name: Any) -> Any:
        policies = nn(self.cb_get("checkpoints"), [])
        return next((p for p in js_iter(policies, "checkpoints") if js_strict_eq(jget(p, "tool"), name)), None)

    def is_user_channel_tool(self, tool: Any) -> bool:
        """D14: the IR declares the tool's output comes from the user."""
        return jget(tool, "channel") == "user"

    def user_decision_keys(self) -> set[str]:
        """D14: state keys owned by user-channel checkpoints (writable only by user tools)."""
        user_ids = {jget(t, "id") for t in self.agent.get("tools") or [] if self.is_user_channel_tool(t)}
        keys: set[str] = set()
        for cp in js_iter(nn(self.cb_get("checkpoints"), []), "checkpoints"):
            if jget(cp, "tool") in user_ids:
                for k in nn(jget(cp, "allow_set_keys"), []):
                    keys.add(js_string(k))
        return keys

    def user_channel_bound(self, name: Any) -> bool:
        """A recorded answer (Track A transcript) or a host user-channel handler is available."""
        return len(self.recorded) > self.ri or name in self.user_tools

    def check_checkpoint_args(
        self, action: dict[str, Any], tool: Any
    ) -> tuple[bool, str | None, str | None, dict[str, Any] | None]:
        """D9: checkpoint authority on the *requested* keys, before execution."""
        policy = self._checkpoint_policy(action["name"])
        if policy is None:
            return True, None, None, None
        allowed = jget(policy, "allow_set_keys")
        allowed_set = set(js_iter(allowed, "allow_set_keys")) if not is_nullish(allowed) else set()
        protected = set() if self.is_user_channel_tool(tool) else self.user_decision_keys()
        requested = nn(jget(jprop_args(action), "set"), {})
        for key in js_object_keys(requested):
            if key not in allowed_set or key in protected:
                return (
                    False,
                    "checkpoint_authority_failed",
                    f"checkpoint args attempted protected key '{key}'",
                    build_checkpoint_key_failure(key),
                )
        return True, None, None, None

    def check_transition_authority(
        self, action: dict[str, Any], tool: Any, transition: Any
    ) -> tuple[bool, str | None, str | None, dict[str, Any] | None]:
        """Keys a tool's state transition may write: checkpoint allow_set_keys, and
        user-decision keys only from user-channel tools (D14)."""
        set_keys = js_object_keys(nn(jget(transition, "set"), {}))
        policy = self._checkpoint_policy(action["name"])
        if policy is not None:
            allowed = jget(policy, "allow_set_keys")
            allowed_set = set(js_iter(allowed, "allow_set_keys")) if not is_nullish(allowed) else set()
            for key in set_keys:
                if key not in allowed_set:
                    return (
                        False,
                        "checkpoint_authority_failed",
                        f"checkpoint transition attempted protected key '{key}'",
                        build_checkpoint_key_failure(key),
                    )
        if not self.is_user_channel_tool(tool):
            protected = self.user_decision_keys()
            if protected:
                removed = [js_string(k) for k in nn(jget(transition, "remove"), [])] if isinstance(
                    jget(transition, "remove"), list
                ) else []
                for key in list(set_keys) + removed:
                    if key in protected:
                        return (
                            False,
                            "checkpoint_authority_failed",
                            f"checkpoint transition attempted protected key '{key}'",
                            build_checkpoint_key_failure(key),
                        )
        return True, None, None, None

    def apply_state_transition(self, transition: Any) -> None:
        if not js_truthy(transition):
            return
        next_state = dict(self.state)
        tset = jget(transition, "set")
        if js_truthy(tset):
            for k, v in js_object_entries(tset):
                next_state[k] = v
                # Fresh write: reset TTL clock when value is truthy / non-zero.
                if not _is_stale_value(v):
                    self.stale_keys.discard(k)
                    self.touch_provenance_fresh(k)
        tremove = jget(transition, "remove")
        if js_truthy(tremove):
            for k in js_iter(tremove, "transition.remove"):
                next_state.pop(js_string(k), None)
        self.agent["state"] = next_state

    # -- D8: provisional transitions --------------------------------------------------

    def _apply_provisional(self, transition: Any) -> None:
        cb = self.cb
        provenance = copy.deepcopy(cb.get("memory_provenance", UNDEFINED)) if isinstance(cb, dict) else UNDEFINED
        keys: set[str] = set(js_object_keys(nn(jget(transition, "set"), {}))) if js_truthy(transition) else set()
        remove = jget(transition, "remove")
        if isinstance(remove, list):
            keys.update(js_string(k) for k in remove)
        self._pending = _Pending(dict(self.state), provenance, set(self.stale_keys), sorted(keys))
        self.apply_state_transition(transition)

    def _commit_pending(self) -> None:
        self._pending = None

    def _discard_pending(self) -> dict[str, Any] | None:
        """Undo the provisional transition; returns the failure marker (if any keys)."""
        p = self._pending
        if p is None:
            return None
        self._pending = None
        self.agent["state"] = p.state
        self.stale_keys = p.stale
        cb = self.cb
        if isinstance(cb, dict):
            if p.provenance is UNDEFINED:
                cb.pop("memory_provenance", None)
            else:
                cb["memory_provenance"] = p.provenance
        return {"kind": "transition_discarded", "keys": p.keys} if p.keys else None

    def _emit_verify_failure(self, partial: dict[str, Any]) -> dict[str, Any]:
        """First failure while verifying a call: discard its transition (D8) and say so."""
        marker = self._discard_pending()
        if marker is not None:
            partial = {**partial, "failure": marker}
        return self.emit(partial)

    # -- native invocation ----------------------------------------------------------

    def invoke_native(self, name: Any, args: Any) -> dict[str, Any]:
        if len(self.recorded) > self.ri:
            entry = self.recorded[self.ri]
            expected_seq = self.ri + 1
            if (
                not js_strict_eq(jget(entry, "call_seq"), expected_seq)
                or not js_strict_eq(jget(entry, "tool"), name)
                or not deep_eq(nn(jget(entry, "args"), {}), args)
            ):
                raise RuntimeError(
                    f"Recorded transcript mismatch: expected call_seq={expected_seq} "
                    f"tool={js_string(name)} args={canonical_json(args)}, got "
                    f"call_seq={js_string(jget(entry, 'call_seq'))} tool={js_string(jget(entry, 'tool'))}"
                )
            self.ri += 1
            return normalize_envelope(jget(entry, "result"))
        handler = self.tools.get(name) if isinstance(name, str) else None
        tool = self.tool_by_id(name)
        if tool is not None and self.is_user_channel_tool(tool) and name not in self.user_tools:
            handler = None  # D14: world handlers never answer the user cell
        if handler is None:
            raise RuntimeError(f"No native handler for {js_string(name)}")
        raw = handler(args, {"state": self.state})
        return normalize_envelope(UNDEFINED if raw is None else raw)

    def apply_fallback_state(self) -> None:
        fb = fallback_state_of(self.agent)
        if js_truthy(fb):
            self.agent["state"] = {**self.state, **js_spread(fb)}
        self.emit({"stage": "record", "verdict": "safe_state", "reason": "safe_state_entered"})

    # -- spawn (D6, D7) -----------------------------------------------------------------

    def _remaining(self) -> tuple[Any, Any]:
        max_steps = js_number(nn(self.limits_get("max_steps"), 1000))
        max_tools = js_number(nn(self.limits_get("max_tool_calls"), 1000))
        return max_steps - self.steps, max_tools - self.tool_calls

    def compare_child_envelope(self, args: Any) -> tuple[bool, str, Any]:
        """Tighten-only child envelope. D6: spawning requires ``spawn.allow`` to be exactly
        ``true``; D7: scopes compare after normalization, segment-wise."""
        spawn = self.agent.get("spawn", UNDEFINED)
        allow = jget(spawn, "allow")
        if allow is not True:
            return False, "gate_denied", "spawn.allow is false" if allow is False else UNDEFINED
        child_tools = nn(jget(args, "tools"), [])
        parent_tools = self.parent_tools()
        if not isinstance(child_tools, list):
            raise JSTypeError("childTools.some is not a function")
        if any(not js_includes(parent_tools, t) for t in child_tools):
            return False, "gate_denied", "tool escalation"
        child_fs = jget(args, "filesystem")
        parent_fs = self.perms_get("filesystem")
        if js_truthy(jget(child_fs, "write_scopes")):
            parents = nn(jget(parent_fs, "write_scopes"), [])
            if any(not scope_covered(s, parents) for s in child_fs["write_scopes"]):
                return False, "gate_denied", "write_scopes escalation"
        if js_truthy(jget(child_fs, "read_scopes")) and js_truthy(jget(parent_fs, "read_scopes")):
            if any(not scope_covered(s, parent_fs["read_scopes"]) for s in child_fs["read_scopes"]):
                return False, "gate_denied", "read_scopes escalation"
        child_limits = jget(args, "limits")
        remaining_steps, remaining_calls = self._remaining()
        cms = jget(child_limits, "max_steps")
        if cms is not UNDEFINED and js_gt(cms, remaining_steps):
            return False, "gate_denied", "max_steps escalation"
        cmt = jget(child_limits, "max_tool_calls")
        if cmt is not UNDEFINED and js_gt(cmt, remaining_calls):
            return False, "gate_denied", "max_tool_calls escalation"
        if jget(args, "spawn_nested") is True or jget(jget(args, "spawn"), "allow") is True:
            if jget(spawn, "allow_nested") is not True:
                return False, "gate_denied", "nested spawn denied"
        return True, "", UNDEFINED

    def build_child_agent(self, args: Any) -> dict[str, Any]:
        child_tool_ids = nn(jget(args, "tools"), [])
        remaining_steps, remaining_calls = self._remaining()
        # D6: the child can never get more budget than the parent has left.
        remaining_steps = js_max(0, remaining_steps)
        remaining_calls = js_max(0, remaining_calls)
        child_limits = jget(args, "limits")
        child_fs = jget(args, "filesystem")
        a = self.agent
        return {
            "spec": a.get("spec", UNDEFINED),
            "name": f"{js_string(a.get('name', UNDEFINED))}/child",
            "state": dict(self.state),
            "tools": [t for t in a.get("tools") or [] if js_includes(child_tool_ids, jget(t, "id"))],
            "gates": a.get("gates", UNDEFINED),
            "limits": {
                "max_steps": nn(jget(child_limits, "max_steps"), remaining_steps),
                "max_tool_calls": nn(jget(child_limits, "max_tool_calls"), remaining_calls),
            },
            "fallback_state": a.get("fallback_state", UNDEFINED),
            "safe_state": a.get("safe_state", UNDEFINED),
            "recovery": a.get("recovery", UNDEFINED),
            "permissions": {
                "tools": child_tool_ids,
                "filesystem": nn(child_fs, self.perms_get("filesystem")),
            },
            "spawn": {
                "allow": jget(a.get("spawn", UNDEFINED), "allow_nested") is True,
                "allow_nested": False,
                "tighten_only": True,
            },
            "counterbalance": a.get("counterbalance", UNDEFINED),
        }

    def run_nested_child(self, args: Any, spawn_id: str) -> int:
        raw = jget(args, "proposals")
        if not isinstance(raw, list) or not raw:
            return 0
        child_agent = self.build_child_agent(args)
        child_tools: dict[str, ToolHandler] = {}
        for tid in nn(jget(args, "tools"), []):
            if isinstance(tid, str) and tid in self.tools:
                child_tools[tid] = self.tools[tid]
        child = FaustRuntime(
            child_agent,
            list(raw),
            child_tools,
            None,
            depth=self.depth + 1,
            spawn_id=spawn_id,
            parse_proposals=False,
            user_tools=self.user_tools & set(child_tools),
        )
        child.run_loop(nn(jget(child_agent.get("limits"), "max_steps"), 32))
        # D6: the child's consumption is charged to the parent's budgets.
        self.steps += child.steps
        self.tool_calls += child.tool_calls
        for cev in child.events:
            self.seq += 1
            merged = dict(cev)
            merged["seq"] = self.seq
            merged["ts_logical"] = self.seq
            merged["depth"] = self.depth + 1
            merged["spawn_id"] = spawn_id
            self.events.append(merged)
        return len(child.events)

    # -- observation / verify ------------------------------------------------------

    def run_observation(self, observer_id: Any) -> tuple[bool, Any]:
        observer = self.tool_by_id(observer_id)
        if not observer or jget(observer, "read_only") is not True:
            self._emit_verify_failure(
                {
                    "stage": "validate",
                    "verdict": "deny",
                    "reason": "capability_missing",
                    "tool": observer_id,
                    "error": "observer missing or not read_only",
                }
            )
            return False, None
        allowed = self.perms_get("tools")
        if js_truthy(allowed) and not js_includes(allowed, observer_id):
            self._emit_verify_failure(
                {"stage": "authorize", "verdict": "deny", "reason": "capability_missing", "tool": observer_id}
            )
            return False, None
        max_tools = nn(self.limits_get("max_tool_calls"), 1000)
        if js_ge(self.tool_calls, max_tools):
            self._emit_verify_failure(
                {"stage": "authorize", "verdict": "deny", "reason": "limit_exceeded", "tool": observer_id}
            )
            return False, None
        self.tool_calls += 1
        try:
            envelope = self.invoke_native(observer_id, {})
        except Exception as e:
            self._emit_verify_failure(
                {
                    "stage": "observe",
                    "verdict": "deny",
                    "reason": "tool_execution_failed",
                    "tool": observer_id,
                    "error": str(e),
                }
            )
            return False, None
        ok, _ = validate_against_schema(jget(observer, "output"), envelope["output"])
        if not ok or not is_canonical(envelope["output"]):
            self._emit_verify_failure(
                {
                    "stage": "observe",
                    "verdict": "deny",
                    "reason": "output_schema_invalid",
                    "tool": observer_id,
                    "error": "output schema validation failed",
                }
            )
            return False, None
        self.emit(
            {"stage": "observe", "verdict": "allow", "tool": observer_id, "args": {}, "result": envelope["output"]}
        )
        return True, envelope["output"]

    def enter_safe_flow(self, trigger_reason: str) -> None:
        self.run_recovery(trigger_reason)

    def run_recovery(self, trigger_reason: str) -> None:
        """D10: recovery runs through the normal validate → authorize (permissions,
        gates, checkpoint authority, limits) → execute → verify path."""
        recovery = self.agent.get("recovery", UNDEFINED)
        if not js_truthy(recovery) or self.recovering:
            self.apply_fallback_state()
            return
        on = jget(recovery, "on")
        if js_truthy(on) and not js_strict_eq(on, trigger_reason):
            self.apply_fallback_state()
            return
        self.recovering = True
        execute = jprop(recovery, "execute")
        action = {"name": jprop(execute, "tool"), "args": nn(jget(execute, "args"), {})}
        self.emit({"stage": "propose", "tool": action["name"], "args": action["args"]})
        outcome = self._governed_call(action, verifies=[jprop(recovery, "verify")], recovery=True)
        if outcome == "ok":
            self.emit({"stage": "record", "verdict": "allow", "reason": "recovery_succeeded"})
        else:
            self.emit({"stage": "record", "verdict": "deny", "reason": "terminal_failure"})
        self.apply_fallback_state()
        self.recovering = False

    def run_verifies(self, verifies: Any, action: dict[str, Any], result: Any) -> bool:
        verifies = nn(verifies, [])
        for v in js_iter(verifies, "verify"):
            if not self.run_one_verify(v, action, result):
                return False
        if len(verifies) == 0:
            self.emit({"stage": "verify", "verdict": "allow"})
        return True

    def run_one_verify(self, v: Any, action: dict[str, Any], result: Any) -> bool:
        kind = jget(v, "kind")
        if kind == "judge":
            raise RuntimeError("judge verify forbidden in Track A")
        if kind == "effect":
            ok, observation = self.run_observation(jget(v, "observe"))
            if not ok:
                return False
            snapshot = {"action": action, "state": self.state, "result": result, "observation": observation}
            if not eval_predicate(jprop(v, "require"), snapshot):
                verdict = nn(jget(v, "otherwise"), "safe_state")
                self._emit_verify_failure(
                    {
                        "stage": "verify",
                        "verdict": verdict,
                        "reason": "verify_effect_failed",
                        "tool": action["name"],
                        "args": action["args"],
                        "observation": observation,
                    }
                )
                if verdict == "safe_state" and not self.recovering:
                    self.enter_safe_flow("verify_effect_failed")
                return False
            self.emit({"stage": "verify", "verdict": "allow", "tool": action["name"], "observation": observation})
            return True
        if kind == "output":
            return self.run_output_verify(v, action, result)
        reason = "verify_evidence_failed" if kind == "evidence" else "verify_absence_failed"
        snapshot = {"action": action, "state": self.state, "result": result}
        if not eval_predicate(jprop(v, "require"), snapshot):
            verdict = nn(jget(v, "otherwise"), "safe_state")
            # D11: no tool-specific observation (the full result is already in the event).
            self._emit_verify_failure(
                {
                    "stage": "verify",
                    "verdict": verdict,
                    "reason": reason,
                    "tool": action["name"],
                    "args": action["args"],
                    "result": result,
                }
            )
            if verdict == "safe_state" and not self.recovering:
                self.enter_safe_flow(reason)
            return False
        self.emit({"stage": "verify", "verdict": "allow", "tool": action["name"], "result": result})
        return True

    @staticmethod
    def build_message_snapshot(content: Any) -> dict[str, Any]:
        c = js_string(nn(content, ""))
        return {
            "content": c,
            "contains_code_fence": 1 if "```" in c else 0,
            # D2: lengths count code points.
            "length": len(c),
        }

    def message_content_from(self, action: dict[str, Any], result: Any) -> str:
        m = jprop(action["args"], "message")
        if isinstance(m, str):
            return m
        r = jprop(result, "message")
        if isinstance(r, str):
            return r
        return ""

    def run_output_verify(self, v: Any, action: dict[str, Any], result: Any) -> bool:
        message = self.build_message_snapshot(self.message_content_from(action, result))
        snapshot = {"action": action, "state": self.state, "result": result, "message": message}
        if not eval_predicate(jprop(v, "require"), snapshot):
            verdict = nn(jget(v, "otherwise"), "deny")
            self._emit_verify_failure(
                {
                    "stage": "verify",
                    "verdict": verdict,
                    "reason": "verify_output_failed",
                    "tool": action["name"],
                    "args": action["args"],
                    "result": result,
                    "observation": {"message": message},
                }
            )
            if verdict == "safe_state" and not self.recovering:
                self.enter_safe_flow("verify_output_failed")
            return False
        self.emit(
            {
                "stage": "verify",
                "verdict": "allow",
                "tool": action["name"],
                "result": result,
                "observation": {"message": message},
            }
        )
        return True

    def run_agent_output_verifies(self, content: str) -> bool:
        verifies = nn(self.cb_get("output_verifies"), [])
        if len(verifies) == 0:
            return True
        action = {"name": "assistant.message", "args": {"message": content}}
        result = {"message": content}
        for v in js_iter(verifies, "output_verifies"):
            if jget(v, "kind") != "output":
                continue
            if not self.run_output_verify(v, action, result):
                return False
        return True

    # -- main loop --------------------------------------------------------------------

    def _deny(self, stage: str, reason: str, action: dict[str, Any], **extra: Any) -> None:
        ev = {"stage": stage, "verdict": "deny", "reason": reason, "tool": action["name"], "args": action["args"]}
        ev.update(extra)
        self.emit(ev)

    def run_loop(self, max_iterations: Any = 32) -> list[dict[str, Any]]:
        """Run proposals until stop, a terminal deny/tool, or the IR limits.

        ``max_iterations`` is the host's safety valve (TS ``runLoop(maxIterations)``);
        ``None`` means no host cap — ``limits.max_steps`` / ``max_tool_calls`` (default
        1000) end the run with a ``limit_exceeded`` event, same as TS ``runLoop(Infinity)``.
        """
        if max_iterations is None:
            max_iterations = math.inf
        consecutive_empty = 0
        i = 0
        while js_gt(max_iterations, i):
            i += 1
            if not self.check_limits():
                break
            self.steps += 1
            self.apply_ttl_invalidation()
            self.check_intervention_budget()
            if jget(self.cb_get("orientation"), "emit_each_step") is True:
                self.emit({"stage": "orient", "verdict": "allow", "observation": self.build_orientation_frame()})

            proposal = self._propose()
            ptype = jget(proposal, "type") if isinstance(proposal, dict) else UNDEFINED
            if not js_truthy(proposal) or ptype == "stop":
                msg = proposal.get("message", UNDEFINED) if ptype == "stop" else UNDEFINED
                stop_message = js_string(msg) if ptype == "stop" and js_truthy(msg) else UNDEFINED
                if stop_message is not UNDEFINED:
                    if not self.run_agent_output_verifies(stop_message):
                        break
                stop_ev: dict[str, Any] = {"stage": "propose", "verdict": "allow"}
                if js_truthy(stop_message):
                    stop_ev["observation"] = {"stop_message": stop_message[:500]}
                self.emit(stop_ev)
                break
            invalid_reason: Any = UNDEFINED
            invalid_message: Any = UNDEFINED
            if ptype == "invalid":
                invalid_reason = proposal.get("reason", UNDEFINED)
                invalid_message = proposal.get("message", UNDEFINED)
            elif not (is_canonical(jget(proposal, "args")) or jget(proposal, "args") is UNDEFINED):
                # D3: non-canonical numbers are rejected where they enter — here, the proposal.
                invalid_reason = "non_canonical_args"
            if invalid_reason is not UNDEFINED or ptype == "invalid":
                consecutive_empty += 1
                self.emit(
                    {
                        "stage": "propose",
                        "verdict": "deny",
                        "reason": "empty_proposal",
                        "error": nn(invalid_message, invalid_reason),
                        "observation": {
                            "invalid_reason": invalid_reason,
                            "stop_message": js_string(invalid_message)[:500] if js_truthy(invalid_message) else None,
                        },
                    }
                )
                # Cap empty-proposal thrash even when continue_after_deny is on.
                if self.deny_is_terminal() or consecutive_empty >= 2:
                    break
                continue
            consecutive_empty = 0

            action = {"name": jget(proposal, "name"), "args": jget(proposal, "args")}
            self.emit({"stage": "propose", "tool": action["name"], "args": action["args"]})
            tool = self.tool_by_id(action["name"])
            outcome = self._governed_call(action, verifies=jget(tool, "verify") if tool else UNDEFINED)
            if outcome == "stop":
                break
            if outcome != "ok":
                if self.deny_is_terminal():
                    break
                continue
            name = action["name"]
            self.apply_invalidate_after(name)
            # First successful terminal tool ends the run (avoid complete/yield spam).
            if self.is_terminal_success_tool(name):
                self.emit({"stage": "record", "verdict": "allow", "reason": "run_complete", "tool": name})
                break
        return self.events

    def _governed_call(self, action: dict[str, Any], *, verifies: Any, recovery: bool = False) -> str:
        """validate → authorize → execute → verify for one tool call.

        Returns ``"ok"`` (executed and verified; transition committed), ``"denied"``
        (denied / failed — transition, if any, not committed) or ``"stop"`` (a gate
        sent the run to its safe state).
        """
        name = action["name"]
        tool = self.tool_by_id(name)
        # -- validate ------------------------------------------------------------
        if not tool:
            self._deny("validate", "capability_missing", action)
            return "denied"
        allowed = self.perms_get("tools")
        # D5/D6: permissions.tools [] permits nothing; agent.spawn is not exempt.
        if js_truthy(allowed) and not js_includes(allowed, name):
            self._deny("validate", "capability_missing", action)
            return "denied"
        if self.is_user_channel_tool(tool) and not self.user_channel_bound(name):
            # D14: an unbound user cell is a missing capability — never a model-authored answer.
            self._deny("validate", "capability_missing", action)
            return "denied"
        ok, _ = validate_against_schema(jget(tool, "input"), action["args"])
        if not ok:
            if name in SKILLS_REFLECTION_TOOLS:
                self.note_reflection_attempt(name)
            self._deny("validate", "input_schema_invalid", action, error="input schema validation failed")
            return "denied"
        self.emit({"stage": "validate", "verdict": "allow", "tool": name, "args": action["args"]})

        # -- authorize -------------------------------------------------------------
        gok, verdict, reason = self.eval_gates({"action": action, "state": self.state})
        if not gok:
            self.emit(
                {"stage": "authorize", "verdict": verdict, "reason": reason, "tool": name, "args": action["args"]}
            )
            if verdict == "safe_state" and not recovery:
                self.enter_safe_flow("gate_denied")
                return "stop"
            return "denied"

        if name == "agent.spawn":
            cok, creason, cerr = self.compare_child_envelope(action["args"])
            if not cok:
                self._deny("authorize", creason, action, error=cerr)
                return "denied"

        if name in SKILLS_REFLECTION_TOOLS:
            rok, rerr = self.reflection_gate(name)
            if not rok:
                self.note_reflection_attempt(name)
                self._deny("authorize", "harness_patch_invalid", action, error=rerr)
                return "denied"

        from .harness_patch import (
            parse_harness_patch,
            parse_skills_patch_decline,
            parse_skills_reflect,
            validate_patch_security,
        )

        if name == "harness.propose_skills_patch":
            patch = parse_harness_patch(action["args"])
            if not patch:
                self.note_reflection_attempt(name)
                self._deny(
                    "authorize", "harness_patch_invalid", action, error="patch requires exactly one op in ops array"
                )
                return "denied"
            pok, preason, perr = validate_patch_security(self.agent, patch)
            if not pok:
                self.note_reflection_attempt(name)
                self._deny("authorize", preason, action, error=perr)
                return "denied"

        if name == "harness.decline_skills_patch":
            if not parse_skills_patch_decline(action["args"]):
                self.note_reflection_attempt(name)
                self._deny(
                    "authorize",
                    "harness_patch_invalid",
                    action,
                    error="decline requires reason in {no_new_heuristic,insufficient_evidence,would_overfit_task,skills_already_adequate}",
                )
                return "denied"

        if name == "harness.reflect_skills":
            reflect = parse_skills_reflect(action["args"])
            if not reflect:
                self.note_reflection_attempt(name)
                self._deny(
                    "authorize",
                    "harness_patch_invalid",
                    action,
                    error="reflect_skills requires disposition decline|propose; decline needs reason; propose needs exactly one op",
                )
                return "denied"
            if reflect["disposition"] == "propose":
                pok, preason, perr = validate_patch_security(self.agent, reflect["patch"])
                if not pok:
                    self.note_reflection_attempt(name)
                    self._deny("authorize", preason, action, error=perr)
                    return "denied"

        sok, sreason, sfail = self.check_sequences(action)
        if not sok:
            self._deny("authorize", sreason, action, failure=sfail)
            return "denied"

        cok2, creason2, cfail2 = self.check_completion(name)
        if not cok2:
            self._deny("authorize", creason2, action, failure=cfail2)
            return "denied"

        # D9: checkpoint authority on requested keys before anything executes.
        kok, kreason, kerr, kfail = self.check_checkpoint_args(action, tool)
        if not kok:
            self._deny("authorize", kreason, action, error=kerr, failure=kfail)
            return "denied"

        if recovery:
            # D10: the recovery call is a tool call like any other (limits apply).
            max_tools = nn(self.limits_get("max_tool_calls"), 1000)
            if js_ge(self.tool_calls, max_tools):
                self._deny("authorize", "limit_exceeded", action)
                return "denied"

        self.emit({"stage": "authorize", "verdict": "allow", "tool": name, "args": action["args"]})
        self.tool_calls += 1

        # -- execute -------------------------------------------------------------
        try:
            envelope = self.invoke_native(name, action["args"])
        except Exception as e:
            self._deny("execute", "tool_execution_failed", action, error=str(e))
            return "denied"

        transition = envelope.get("state_transition", UNDEFINED)
        ok, _ = validate_against_schema(jget(tool, "output"), envelope["output"])
        # D3: non-integral / non-finite numbers are rejected where they enter.
        if (
            not ok
            or not is_canonical(envelope["output"])
            or (transition is not UNDEFINED and not is_canonical(transition))
        ):
            self._deny("execute", "output_schema_invalid", action, error="output schema validation failed")
            return "denied"

        tok, treason, terr, tfail = self.check_transition_authority(action, tool, transition)
        if not tok:
            self._deny("execute", treason, action, error=terr, failure=tfail)
            return "denied"

        self._apply_provisional(transition)
        self.emit({"stage": "execute", "verdict": "allow", "tool": name, "args": action["args"], "result": envelope["output"]})

        if name == "agent.spawn":
            spawn_id = f"spawn-{self.seq}"
            child_steps = self.run_nested_child(action["args"], spawn_id)
            if child_steps > 0:
                exec_ev = self.events[len(self.events) - 1 - child_steps]
                if exec_ev.get("stage") == "execute" and exec_ev.get("tool") == "agent.spawn":
                    exec_ev["result"] = {**js_spread(envelope["output"]), "child_events": child_steps}

        self._after_execute_harness_cells(name, action)

        # -- verify (D8: success = executed AND verified) -------------------------------
        if not self.run_verifies(verifies, action, envelope["output"]):
            self._discard_pending()
            return "denied"
        self._commit_pending()
        self.succeeded.append(name)
        return "ok"

    def _after_execute_harness_cells(self, name: Any, action: dict[str, Any]) -> None:
        from .harness_patch import (
            apply_harness_patch,
            harness_ir_hash,
            parse_harness_patch,
            parse_skills_patch_decline,
            parse_skills_reflect,
        )

        if name == "harness.propose_skills_patch":
            patch = parse_harness_patch(action["args"])
            if patch:
                before = harness_ir_hash(self.agent)
                apply_harness_patch(self.agent, patch)
                after = harness_ir_hash(self.agent)
                self.emit(
                    {
                        "stage": "rebalance",
                        "verdict": "allow",
                        "reason": "harness_patch_applied",
                        "tool": name,
                        "args": action["args"],
                        "harness_hash_before": before,
                        "harness_hash_after": after,
                        "observation": {"ops": len(patch["ops"])},
                    }
                )
        if name == "harness.decline_skills_patch":
            decline = parse_skills_patch_decline(action["args"])
            if decline:
                obs: dict[str, Any] = {"reason": decline["reason"]}
                if "note" in decline:
                    obs["note"] = decline["note"]
                self.emit(
                    {
                        "stage": "record",
                        "verdict": "allow",
                        "reason": "harness_patch_declined",
                        "tool": name,
                        "args": action["args"],
                        "observation": obs,
                    }
                )
        if name == "harness.reflect_skills":
            reflect = parse_skills_reflect(action["args"])
            if reflect and reflect["disposition"] == "propose":
                patch = reflect["patch"]
                before = harness_ir_hash(self.agent)
                apply_harness_patch(self.agent, patch)
                after = harness_ir_hash(self.agent)
                self.emit(
                    {
                        "stage": "rebalance",
                        "verdict": "allow",
                        "reason": "harness_patch_applied",
                        "tool": name,
                        "args": action["args"],
                        "harness_hash_before": before,
                        "harness_hash_after": after,
                        "observation": {"ops": len(patch["ops"]), "disposition": "propose"},
                    }
                )
            elif reflect and reflect["disposition"] == "decline":
                obs2: dict[str, Any] = {"reason": reflect["reason"], "disposition": "decline"}
                if "note" in reflect:
                    obs2["note"] = reflect["note"]
                self.emit(
                    {
                        "stage": "record",
                        "verdict": "allow",
                        "reason": "harness_patch_declined",
                        "tool": name,
                        "args": action["args"],
                        "observation": obs2,
                    }
                )


def jprop_args(action: dict[str, Any]) -> Any:
    """``action.args`` dereferenced for a property read (throws on null/undefined)."""
    args = action["args"]
    if args is UNDEFINED or args is None:
        jprop(args, "set")
    return args


def events_to_jsonl(events: list[dict[str, Any]]) -> str:
    return jsonl_lines(events)


# --------------------------------------------------------------------------
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
            result: dict[str, Any] = {"output": out}
            if js_strict_eq(code, 0):
                result["state_transition"] = {"set": {"test_evidence_current": 1}}
            return result
        out_deny: dict[str, Any] = {"exit_code": 1, "cmd": cmd, "error": SHELL_NOT_ALLOWLISTED_ERROR}
        if protect:
            out_deny["protected_modified"] = 0
        return {"output": out_deny}

    def kb_lookup(args: Any, ctx: dict[str, Any]) -> dict[str, Any]:
        # D2: truncation counts code points.
        query = js_string(nn(jprop(args, "query"), "x"))[:24]
        return {"output": {"ok": 1, "article_id": f"kb-{query}"}, "state_transition": {"set": {"kb_cited": 1}}}

    def reflect(args: Any, ctx: dict[str, Any]) -> dict[str, Any]:
        if jprop(args, "disposition") == "propose":
            return {"output": {"ok": 1, "disposition": "propose", "proposed": 1}}
        return {"output": {"ok": 1, "disposition": "decline", "declined": 1}}

    def echo(args: Any, ctx: dict[str, Any]) -> dict[str, Any]:
        return {"output": {"ok": 1, "echo": js_string(nn(jprop(args, "message"), "pong"))}}

    # D14: no `user.ask` world stub — the user cell is answered by a host user channel only.
    return {
        "fs.read": fs_read,
        "fs.list": fs_list,
        "fs.write_scoped": fs_write,
        "shell.run_allowlisted": shell,
        "user.approve": lambda a, c: {"output": {"approved": 0}},
        "user.correct": lambda a, c: {"output": {"ok": 1}},
        "task.complete": lambda a, c: {"output": {"ok": 1}},
        "phase.yield": lambda a, c: {
            "output": {"ok": 1},
            "state_transition": {"set": {"phase_yielded": 1, "researched": 1}},
        },
        "kb.lookup": kb_lookup,
        "answer.send": lambda a, c: {"output": {"ok": 1}},
        "human.handoff": lambda a, c: {"output": {"ok": 1}, "state_transition": {"set": {"handoff": 1}}},
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


def replay_fixture(dir_path: Path) -> tuple[bool, str, str]:
    from .canonical import read_text_utf8

    dir_path = Path(dir_path)
    agent = load_fixture_agent(dir_path)
    proposals = [parse_recorded_model_line(x) for x in read_jsonl(dir_path / "model.jsonl")]
    tools_path = dir_path / "tools.jsonl"
    recorded = read_jsonl(tools_path) if tools_path.exists() else []
    rt = FaustRuntime(agent, proposals, default_tools(agent), recorded or None)
    rt.run_loop()
    actual = events_to_jsonl(rt.events)
    expected = read_text_utf8(dir_path / "expected.jsonl").replace("\r\n", "\n")
    return actual == expected, actual, expected
