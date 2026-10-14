"""Fausth engine — the governed exchange loop (Python twin of engines/ts/src/runtime.ts).

Normative text: docs/spec-v0.3.md. This module mirrors the TS runtime line for line so that
both engines emit byte-identical canonical event logs. The engine knows no harness- or
domain-specific names (D11).
"""

from __future__ import annotations

import copy
import hashlib
import posixpath
import re
from typing import Any, Callable

from .canonical import canonical_json

# ------------------------------------------------------------------ constants (types.ts)

SPAWN_TOOL = "agent.spawn"
PATCH_TOOL = "harness.propose_skills_patch"
DECLINE_TOOL = "harness.decline_skills_patch"
REFLECT_TOOL = "harness.reflect_skills"
REFLECTION_TOOLS = (PATCH_TOOL, DECLINE_TOOL, REFLECT_TOOL)

DEFAULT_LIMIT = 1000
DEFAULT_MAX_OBSERVATION_CHARS = 8000
EXCERPT_CHARS = 500
REDACTED = "[redacted]"
TRUNCATION_SUFFIX = "…[truncated]"
INT53_MAX = 2**53 - 1
INT53_MIN = -(2**53 - 1)

ADAPTER_ERROR_CODES = (
    "binding_missing",
    "adapter_unresolved",
    "spawn_not_allowed",
    "recorded_response_missing",
    "user_channel_unavailable",
    "host_session_failed",
)


class _Undefined:
    """JS ``undefined`` (absent member), distinct from JSON null."""

    def __repr__(self) -> str:
        return "undefined"


UNDEFINED = _Undefined()


def js_string(v: Any) -> str:
    """JS ``String(v)`` for the values a proposal can carry."""
    if v is UNDEFINED:
        return "undefined"
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    return str(v)


class _Missing:
    def __repr__(self) -> str:
        return "MISSING"


MISSING = _Missing()

# ------------------------------------------------------------------ canonical values (§1)


def is_plain_object(v: Any) -> bool:
    return isinstance(v, dict)


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _well_formed(s: str) -> bool:
    return not any(0xD800 <= ord(ch) <= 0xDFFF for ch in s)


def sort_cp(xs: Any) -> list[str]:
    """Code point order (Python string order is code point order)."""
    return sorted(xs)


def excerpt(s: str, n: int) -> str:
    return s if len(s) <= n else s[:n] + TRUNCATION_SUFFIX


def to_canonical(value: Any, path: str = "$") -> tuple[bool, Any, str]:
    """(ok, canonical value, failure path). Never raises."""
    if value is UNDEFINED:
        return False, None, path
    if value is None or isinstance(value, bool):
        return True, value, ""
    if isinstance(value, str):
        return (True, value, "") if _well_formed(value) else (False, None, path)
    if isinstance(value, int):
        if value < INT53_MIN or value > INT53_MAX:
            return False, None, path
        return True, value, ""
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")) or not value.is_integer():
            return False, None, path
        iv = int(value)
        if iv < INT53_MIN or iv > INT53_MAX:
            return False, None, path
        return True, iv, ""
    if isinstance(value, (list, tuple)):
        out = []
        for i, item in enumerate(value):
            ok, v, p = to_canonical(item, f"{path}[{i}]")
            if not ok:
                return False, None, p
            out.append(v)
        return True, out, ""
    if isinstance(value, dict):
        out_d: dict[str, Any] = {}
        for key in sort_cp([k for k in value.keys() if isinstance(k, str)]):
            if not _well_formed(key):
                return False, None, path
            ok, v, p = to_canonical(value[key], f"{path}.{key}")
            if not ok:
                return False, None, p
            out_d[key] = v
        if any(not isinstance(k, str) for k in value.keys()):
            return False, None, path
        return True, out_d, ""
    return False, None, path


def deep_eq(a: Any, b: Any) -> bool:
    oa, va, _ = to_canonical(a)
    ob, vb, _ = to_canonical(b)
    if not oa or not ob:
        return False
    return canonical_json(va) == canonical_json(vb)


def state_hash(state: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(state).encode("utf-8")).hexdigest()


# ------------------------------------------------------------------ predicates (§3)


def get_path(snapshot: Any, path: str) -> Any:
    cur = snapshot
    for p in path.split("."):
        if not isinstance(cur, dict) or p not in cur:
            return MISSING
        cur = cur[p]
    return cur


def eval_predicate(pred: dict[str, Any], snap: dict[str, Any]) -> bool:
    if "all" in pred:
        return all(eval_predicate(p, snap) for p in pred["all"])
    if "any" in pred:
        return any(eval_predicate(p, snap) for p in pred["any"])
    if "not" in pred:
        return not eval_predicate(pred["not"], snap)
    value = get_path(snap, pred["path"])
    if "eq_path" in pred:
        other = get_path(snap, pred["eq_path"])
        if value is MISSING and other is MISSING:
            return True
        if value is MISSING or other is MISSING:
            return False
        return deep_eq(value, other)
    if "eq" in pred:
        return value is not MISSING and deep_eq(value, pred["eq"])
    if "neq" in pred:
        return value is not MISSING and not deep_eq(value, pred["neq"])
    if value is MISSING or not _is_int(value):
        return False
    if "lt" in pred:
        return value < pred["lt"]
    if "lte" in pred:
        return value <= pred["lte"]
    if "gt" in pred:
        return value > pred["gt"]
    if "gte" in pred:
        return value >= pred["gte"]
    return False


# ------------------------------------------------------------------ deny failures (deny-failure.ts)


def _leaf_require(p: dict[str, Any]) -> dict[str, Any]:
    for k in ("eq", "neq", "eq_path", "lt", "lte", "gt", "gte"):
        if k in p:
            return {k: p[k]}
    return {}


def failing_predicates(pred: dict[str, Any], snap: dict[str, Any]) -> list[dict[str, Any]]:
    if "all" in pred:
        return [f for p in pred["all"] for f in failing_predicates(p, snap)]
    if "any" in pred:
        if eval_predicate(pred, snap):
            return []
        return [f for p in pred["any"] for f in failing_predicates(p, snap)]
    if "not" in pred:
        return [pred] if eval_predicate(pred["not"], snap) else []
    return [] if eval_predicate(pred, snap) else [pred]


def build_predicate_failure(pred: dict[str, Any], snap: dict[str, Any], checkpoints: list[dict[str, Any]]) -> dict[str, Any]:
    failed = []
    for p in failing_predicates(pred, snap):
        if "path" not in p:
            continue
        path = p["path"]
        cur = get_path(snap, path)
        item: dict[str, Any] = {"path": path, "current": None if cur is MISSING else cur, "require": _leaf_require(p)}
        if "eq" in p and path.startswith("state."):
            key = path[len("state."):]
            for cp in checkpoints:
                if key in (cp.get("allow_set_keys") or []):
                    item["unblock"] = {"tool": cp["tool"], "set_key": key, "set_value": p["eq"]}
                    break
        failed.append(item)
    return {"kind": "predicate", "failed": failed}


def spawn_failure(code: str, dimension: str | None = None) -> dict[str, Any]:
    return {"kind": "spawn", "code": code, "dimension": dimension} if dimension else {"kind": "spawn", "code": code}


# ------------------------------------------------------------------ harness patches (harness-patch.ts)

DECLINE_REASONS = ("no_new_heuristic", "insufficient_evidence", "would_overfit_task", "skills_already_adequate")
FORBIDDEN_OPS = {
    "set_permissions_tools", "set_sequences", "set_checkpoints", "set_tool_id",
    "set_tool_verify", "set_tool_input", "set_tool_output",
}
OP_CELL = {"set_tool_description": "skills", "set_memory_note": "memory", "set_instinct_text": "instincts"}


def parse_decline(args: dict[str, Any]) -> dict[str, Any] | None:
    reason = args.get("reason")
    if not isinstance(reason, str) or reason not in DECLINE_REASONS:
        return None
    note = args.get("note")
    if "note" in args and not isinstance(note, str):
        return None
    out: dict[str, Any] = {"reason": reason}
    if isinstance(note, str):
        out["note"] = note
    return out


def parse_patch(args: dict[str, Any]) -> dict[str, Any] | None:
    ops = args.get("ops")
    if not isinstance(ops, list) or len(ops) != 1:
        return None
    return {"ops": ops}


def validate_patch_security(agent: dict[str, Any], patch: dict[str, Any]) -> tuple[bool, str, str]:
    if len(patch["ops"]) != 1:
        return False, "harness_patch_invalid", "malformed_patch"
    for op in patch["ops"]:
        if not isinstance(op, dict) or not isinstance(op.get("op"), str):
            return False, "harness_patch_invalid", "malformed_op"
        kind = op["op"]
        if kind in FORBIDDEN_OPS:
            return False, "harness_patch_denied", "immutable_surface"
        cell = OP_CELL.get(kind)
        if not cell:
            return False, "harness_patch_invalid", "unknown_op"
        if cell not in (agent.get("mutable") or []):
            return False, "harness_patch_denied", "cell_not_mutable"
        if kind == "set_tool_description":
            if not isinstance(op.get("tool_id"), str) or not isinstance(op.get("description"), str):
                return False, "harness_patch_invalid", "malformed_op"
            if not any(t.get("id") == op["tool_id"] for t in agent.get("tools") or []):
                return False, "harness_patch_invalid", "unknown_tool"
        elif kind == "set_memory_note":
            if not isinstance(op.get("key"), str) or len(op["key"]) == 0 or not isinstance(op.get("note"), str):
                return False, "harness_patch_invalid", "malformed_op"
        elif kind == "set_instinct_text":
            if not isinstance(op.get("text"), str):
                return False, "harness_patch_invalid", "malformed_op"
    return True, "", ""


def harness_ir_hash(agent: dict[str, Any], initial_state: dict[str, Any] | None = None) -> str:
    ir = {**agent, "state": initial_state} if initial_state is not None else agent
    return hashlib.sha256(canonical_json(ir).encode("utf-8")).hexdigest()


def apply_harness_patch(agent: dict[str, Any], patch: dict[str, Any]) -> None:
    for op in patch["ops"]:
        if op["op"] == "set_tool_description":
            for t in agent.get("tools") or []:
                if t.get("id") == op["tool_id"]:
                    t["description"] = op["description"]
                    break
        elif op["op"] == "set_memory_note":
            cb = agent.setdefault("counterbalance", {})
            cb.setdefault("memory_notes", {})[op["key"]] = op["note"]
        elif op["op"] == "set_instinct_text":
            agent["instinct_text"] = op["text"]


# ------------------------------------------------------------------ scopes (scopes.ts)

_ROOT_FORMS = {".", "./", "*", "**"}
_DRIVE = re.compile(r"^[a-zA-Z]:")


def parse_scope(raw: Any) -> tuple[bool, Any]:
    """(ok, scope) where scope is "ROOT" or a list of segments."""
    if not isinstance(raw, str):
        return False, None
    unified = raw.replace("\\", "/").strip()
    if unified in _ROOT_FORMS:
        return True, "ROOT"
    if "*" in unified or not unified or "\0" in unified:
        return False, None
    if unified.startswith("/") or _DRIVE.match(unified):
        return False, None
    norm = posixpath.normpath(unified).rstrip("/") if unified else ""
    if norm in ("", "."):
        return False, None
    if norm == ".." or norm.startswith("../"):
        return False, None
    segs = norm.split("/")
    if any(s.lower() == ".git" for s in segs):
        return False, None
    return True, segs


def scope_contains(parent: Any, child: Any) -> bool:
    if parent == "ROOT":
        return True
    if child == "ROOT":
        return False
    if len(parent) > len(child):
        return False
    return all(child[i] == s for i, s in enumerate(parent))


# ------------------------------------------------------------------ misc helpers


def build_message_snapshot(content: Any) -> dict[str, Any]:
    c = "" if content is None else str(content)
    return {"content": c, "contains_code_fence": 1 if "```" in c else 0, "length": len(c)}


def _is_fresh(v: Any) -> bool:
    if v is None or v is False or v == "":
        return False
    if _is_int(v) and v == 0:
        return False
    return True


def read_envelope(raw: Any) -> tuple[dict[str, Any], dict[str, Any] | None] | None:
    if not isinstance(raw, dict):
        return None
    if "_state_patch" in raw:
        return None
    if "output" not in raw:
        if "state_transition" in raw:
            return None
        return raw, None
    for k in raw:
        if k not in ("output", "state_transition"):
            return None
    if not isinstance(raw["output"], dict):
        return None
    st = raw.get("state_transition")
    if st is None:
        return raw["output"], None
    if not isinstance(st, dict):
        return None
    for k in st:
        if k not in ("set", "remove"):
            return None
    if "set" in st and not isinstance(st["set"], dict):
        return None
    if "remove" in st and (not isinstance(st["remove"], list) or any(not isinstance(x, str) for x in st["remove"])):
        return None
    transition: dict[str, Any] = {}
    if "set" in st:
        transition["set"] = st["set"]
    if "remove" in st:
        transition["remove"] = st["remove"]
    return raw["output"], transition


def _non_neg_int(v: Any) -> bool:
    return _is_int(v) and v >= 0


def parse_spawn_packet(args: dict[str, Any]) -> dict[str, Any] | None:
    tools = args.get("tools")
    if not isinstance(tools, list) or any(not isinstance(t, str) or len(t) == 0 for t in tools):
        return None
    packet: dict[str, Any] = {"tools": tools, "nested": False}
    if "filesystem" in args:
        fs = args["filesystem"]
        if not isinstance(fs, dict) or any(k not in ("write_scopes", "read_scopes") for k in fs):
            return None
        for k in ("write_scopes", "read_scopes"):
            if k not in fs:
                continue
            v = fs[k]
            if not isinstance(v, list) or any(not isinstance(s, str) or not parse_scope(s)[0] for s in v):
                return None
            packet[k] = v
    if "limits" in args:
        lim = args["limits"]
        if not isinstance(lim, dict) or any(k not in ("max_steps", "max_tool_calls") for k in lim):
            return None
        for k in ("max_steps", "max_tool_calls"):
            if k not in lim:
                continue
            if not _non_neg_int(lim[k]):
                return None
            packet[k] = lim[k]
    if "spawn_nested" in args:
        if not isinstance(args["spawn_nested"], bool):
            return None
        if args["spawn_nested"]:
            packet["nested"] = True
    if "spawn" in args:
        sp = args["spawn"]
        if not isinstance(sp, dict):
            return None
        if "allow" in sp and not isinstance(sp["allow"], bool):
            return None
        if sp.get("allow") is True:
            packet["nested"] = True
    if "proposals" in args:
        props = args["proposals"]
        if not isinstance(props, list) or any(not isinstance(p, dict) for p in props):
            return None
        packet["proposals"] = props
    return packet


def to_proposal(raw: Any) -> dict[str, Any]:
    o = raw if isinstance(raw, dict) else {}
    if o.get("type") == "stop":
        return {"type": "stop", "message": o["message"]} if isinstance(o.get("message"), str) else {"type": "stop"}
    if o.get("type") == "invalid":
        out = {"type": "invalid", "reason": o["reason"] if isinstance(o.get("reason"), str) else "invalid"}
        if isinstance(o.get("message"), str):
            out["message"] = o["message"]
        return out
    name = o.get("name")
    if name is None:
        name = o.get("tool")
    return {"type": "tool", "name": "" if name is None else str(name), "args": o["args"] if isinstance(o.get("args"), dict) else {}}


def _validate_schema(schema: Any, data: Any) -> tuple[bool, bool]:
    """(ok, compile_error) with spec-v0.3 semantics (standard JSON Schema, no injected
    defaults, ``format`` not asserted, top-level ``$id``/``$schema`` ignored)."""
    from .schema_validate import validate_standard

    return validate_standard(schema, data)


class TranscriptCursor:
    def __init__(self, entries: list[dict[str, Any]]) -> None:
        self.idx = 0
        self.entries = entries


ToolHandler = Callable[[dict[str, Any], dict[str, Any]], Any]


# ------------------------------------------------------------------ the runtime


class FaustRuntime:
    """Twin of TS ``FaustRuntime``.

    ``proposals`` is a list of recorded model lines, a callable returning the next proposal
    (or None), or a list-like queue. ``recorded_tool_results`` (even empty) puts the run in
    recorded-transcript mode; ``None`` does not.
    """

    def __init__(
        self,
        agent: dict[str, Any],
        proposals: Any,
        tools: dict[str, ToolHandler],
        recorded_tool_results: list[dict[str, Any]] | None = None,
        *,
        depth: int = 0,
        spawn_id: str | None = None,
        parse_proposals: bool = True,
        user_tools: Any = None,
        judge: Callable[..., Any] | None = None,
        allow_judge: bool = False,
        transcript: TranscriptCursor | None = None,
    ) -> None:
        a = copy.deepcopy(agent)
        if a.get("safe_state") and not a.get("fallback_state"):
            a["fallback_state"] = a["safe_state"]
        if not isinstance(a.get("state"), dict):
            a["state"] = {}
        if not isinstance(a.get("tools"), list):
            a["tools"] = []
        self.agent = a
        self.initial_state = copy.deepcopy(a["state"])
        self.declared_keys = set(a["state"].keys())
        self.events: list[dict[str, Any]] = []
        self.seq = 0
        self.steps = 0
        self.tool_calls = 0
        if callable(proposals) and not hasattr(proposals, "__getitem__"):
            self._propose = proposals
        else:
            queue = proposals
            if parse_proposals and isinstance(proposals, list):
                queue = [to_proposal(p) for p in proposals]
            state = {"pi": 0}

            def _next() -> Any:
                if state["pi"] >= len(queue):
                    return {"type": "stop"}
                p = queue[state["pi"]]
                state["pi"] += 1
                return p

            self._propose = _next
        self.tools = tools
        self.user_tools = None if user_tools is None else set(user_tools)
        if self.user_tools is None and getattr(tools, "user_tools", None) is not None:
            self.user_tools = set(getattr(tools, "user_tools"))
        self.judge = judge
        self.allow_judge = allow_judge
        if transcript is not None:
            self.transcript: TranscriptCursor | None = transcript
        elif recorded_tool_results is not None:
            self.transcript = TranscriptCursor(recorded_tool_results)
        else:
            self.transcript = None
        self.depth = depth
        self.spawn_id = spawn_id
        self.provenance: dict[str, dict[str, Any]] = {}
        declared = ((a.get("counterbalance") or {}).get("memory_provenance") or {})
        for key, value in a["state"].items():
            d = declared.get(key) or {}
            self.provenance[key] = {
                "status": d.get("status") or ("current" if _is_fresh(value) else "stale"),
                "updated_at_step": d.get("updated_at_step", 0),
            }
        self.succeeded: set[str] = set()
        self.reflection_denials: dict[str, int] = {}
        self.budget_emitted = False
        self.recovering = False
        self.infra_failed = False
        self.host_step_cap: int | None = None

    # ---------------------------------------------------------------- compat accessors

    @property
    def state(self) -> dict[str, Any]:
        return self.agent["state"]

    def successful_executes(self) -> set[str]:
        return set(self.succeeded)

    def successful_tools(self) -> list[str]:
        return sort_cp(self.succeeded)

    def usage(self) -> dict[str, int]:
        return {"steps": self.steps, "tool_calls": self.tool_calls}

    # ---------------------------------------------------------------- events

    def emit(self, partial: dict[str, Any]) -> dict[str, Any]:
        self.seq += 1
        ev: dict[str, Any] = {"seq": self.seq, "ts_logical": self.seq, "state_hash": state_hash(self.agent["state"]), "stage": partial["stage"]}
        for k in ("verdict", "reason", "tool", "args", "result", "observation", "error", "failure"):
            if partial.get(k) is not None:
                ev[k] = partial[k]
        if self.depth > 0:
            ev["depth"] = self.depth
        if self.spawn_id:
            ev["spawn_id"] = self.spawn_id
        for k in ("harness_hash_before", "harness_hash_after"):
            if partial.get(k) is not None:
                ev[k] = partial[k]
        self.events.append(ev)
        return ev

    # ---------------------------------------------------------------- IR helpers

    def _cb(self) -> dict[str, Any]:
        return self.agent.get("counterbalance") or {}

    def _limits(self) -> dict[str, Any]:
        return self.agent.get("limits") or {}

    def tool_by_id(self, tid: str) -> dict[str, Any] | None:
        for t in self.agent["tools"]:
            if t.get("id") == tid:
                return t
        return None

    def max_steps(self) -> int:
        v = self._limits().get("max_steps")
        return DEFAULT_LIMIT if v is None else v

    def max_tool_calls(self) -> int:
        v = self._limits().get("max_tool_calls")
        return DEFAULT_LIMIT if v is None else v

    def max_observation_chars(self) -> int:
        v = self._limits().get("max_observation_chars")
        return DEFAULT_MAX_OBSERVATION_CHARS if v is None else v

    def is_permitted(self, tid: str) -> bool:
        p = (self.agent.get("permissions") or {}).get("tools")
        if p is None:
            return any(t.get("id") == tid for t in self.agent["tools"])
        return tid in p

    def permitted_tools(self) -> list[str]:
        return sort_cp([t["id"] for t in self.agent["tools"] if self.is_permitted(t["id"])])

    def continue_after_deny(self) -> bool:
        return self._limits().get("continue_after_deny") is True

    def checkpoints(self) -> list[dict[str, Any]]:
        return self._cb().get("checkpoints") or []

    # ---------------------------------------------------------------- world feedback (§14)

    def secret_values(self) -> list[str]:
        vals = ((self.agent.get("permissions") or {}).get("secrets") or {}).get("values") or []
        uniq = [v for v in dict.fromkeys(vals) if isinstance(v, str) and len(v) > 0]
        return sorted(uniq, key=lambda s: (-len(s), s))

    def sanitize_string(self, s: str) -> str:
        out = s
        for secret in self.secret_values():
            if secret in out:
                out = REDACTED.join(out.split(secret))
        return excerpt(out, self.max_observation_chars())

    def sanitize(self, value: Any) -> Any:
        if isinstance(value, str):
            return self.sanitize_string(value)
        if isinstance(value, list):
            return [self.sanitize(v) for v in value]
        if isinstance(value, dict):
            return {k: self.sanitize(v) for k, v in value.items()}
        return value

    # ---------------------------------------------------------------- invocation (§15.1)

    def invoke(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        if self.transcript is not None:
            cur = self.transcript
            expected = cur.idx + 1
            if cur.idx >= len(cur.entries):
                return {"ok": False, "infra": False, "failure": {"kind": "transcript", "code": "exhausted", "call_seq": expected}}
            entry = cur.entries[cur.idx]
            if entry.get("call_seq") != expected or entry.get("tool") != name or not deep_eq(entry.get("args") or {}, args):
                return {"ok": False, "infra": False, "failure": {"kind": "transcript", "code": "mismatch", "call_seq": expected}}
            cur.idx += 1
            return {"ok": True, "raw": entry.get("result")}
        handler = self.tools.get(name) if hasattr(self.tools, "get") else None
        if not callable(handler):
            return {"ok": False, "infra": False, "failure": {"kind": "host_error"}}
        try:
            return {"ok": True, "raw": handler(args, {"state": copy.deepcopy(self.agent["state"])})}
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            err = {"error": self.sanitize_string(msg)} if msg else {}
            code = getattr(e, "code", None)
            if type(e).__name__ == "AdapterError" and isinstance(code, str) and code in ADAPTER_ERROR_CODES:
                failure: dict[str, Any] = {"kind": "adapter", "code": code}
                detail = getattr(e, "detail", None)
                if isinstance(detail, dict):
                    ok, cval, _ = to_canonical(detail)
                    if ok:
                        failure["detail"] = self.sanitize(cval)
                return {"ok": False, "infra": True, "failure": failure, **err}
            return {"ok": False, "infra": False, "failure": {"kind": "host_error"}, **err}

    def is_bound(self, tid: str) -> bool:
        if self.transcript is not None:
            return True
        tool = self.tool_by_id(tid)
        if tool is not None and tool.get("channel") == "user" and self.user_tools is not None and tid not in self.user_tools:
            return False
        h = self.tools.get(tid) if hasattr(self.tools, "get") else None
        return callable(h)

    # ---------------------------------------------------------------- run loop (§5)

    def effective_max_steps(self) -> int:
        own = self.max_steps()
        return own if self.host_step_cap is None else min(own, self.host_step_cap)

    def check_limits(self) -> bool:
        if self.steps >= self.effective_max_steps() or self.tool_calls >= self.max_tool_calls():
            self.emit({"stage": "authorize", "verdict": "deny", "reason": "limit_exceeded"})
            return False
        return True

    def run_loop(self, host_step_cap: Any = None) -> list[dict[str, Any]]:
        if _is_int(host_step_cap) and host_step_cap >= 0:
            self.host_step_cap = host_step_cap
        consecutive_invalid = 0
        while True:
            if not self.check_limits():
                break
            self.steps += 1
            self.apply_ttl_invalidation()
            self.check_intervention_budget()
            if ((self._cb().get("orientation") or {}).get("emit_each_step")) is True:
                self.emit({"stage": "orient", "verdict": "allow", "observation": self.build_orientation_frame()})
            proposal = self._propose()
            if not proposal or proposal.get("type") == "stop":
                m = None
                if proposal and isinstance(proposal.get("message"), str) and len(proposal["message"]) > 0:
                    m = proposal["message"]
                ev: dict[str, Any] = {"stage": "propose", "verdict": "allow"}
                if m is not None:
                    ev["observation"] = {"stop_message": excerpt(m, EXCERPT_CHARS)}
                self.emit(ev)
                if m is not None and len(self._cb().get("output_verifies") or []) > 0:
                    verdict = self.run_agent_output_verifies(m)
                    if verdict == "deny" and self.continue_after_deny():
                        continue
                    if verdict == "safe_state":
                        self.safe_flow("verify_output_failed")
                break
            if proposal.get("type") == "invalid":
                consecutive_invalid += 1
                text = proposal.get("message") if isinstance(proposal.get("message"), str) else None
                reason = proposal.get("reason")
                self.emit(
                    {
                        "stage": "propose",
                        "verdict": "deny",
                        "reason": "empty_proposal" if reason == "empty_proposal" else "invalid_proposal",
                        "observation": {
                            "invalid_reason": excerpt(str(reason if reason is not None else ""), EXCERPT_CHARS),
                            "stop_message": excerpt(text, EXCERPT_CHARS) if text is not None else None,
                        },
                    }
                )
                if not self.continue_after_deny() or consecutive_invalid >= 2:
                    break
                continue
            consecutive_invalid = 0
            outcome = self.process_action(
                {"name": js_string(proposal.get("name", UNDEFINED)), "args": proposal.get("args", UNDEFINED)}, "model"
            )
            if outcome in ("complete", "safe_state", "infra"):
                break
            if outcome == "denied" and not self.continue_after_deny():
                break
        return self.events

    # ---------------------------------------------------------------- one action (§6)

    def process_action(self, action: dict[str, Any], origin: str) -> str:
        ok, args, path = to_canonical(action["args"], "$.args")
        if not ok:
            self.emit({"stage": "propose", "verdict": "deny", "reason": "input_schema_invalid", "tool": action["name"], "failure": {"kind": "non_canonical", "path": path}})
            return "denied"
        act = {"name": action["name"], "args": args}
        ev: dict[str, Any] = {"stage": "propose", "tool": act["name"], "args": args}
        if origin == "recovery":
            ev["reason"] = "recovery_attempt"
        self.emit(ev)
        name = act["name"]
        tool = self.tool_by_id(name)

        def deny(stage: str, reason: str, failure: dict[str, Any] | None = None, verdict: str = "deny") -> None:
            e: dict[str, Any] = {"stage": stage, "verdict": verdict, "reason": reason, "tool": name, "args": args}
            if failure is not None:
                e["failure"] = failure
            self.emit(e)

        if tool is None or not self.is_permitted(name):
            deny("validate", "capability_missing")
            return "denied"
        reflection = name in REFLECTION_TOOLS
        if not isinstance(args, dict):
            if reflection:
                self.note_reflection_denial(name)
            deny("validate", "input_schema_invalid")
            return "denied"
        in_ok, in_compile = _validate_schema(tool.get("input"), args)
        if not in_ok:
            if in_compile:
                deny("validate", "schema_invalid")
                return "denied"
            if reflection:
                self.note_reflection_denial(name)
            deny("validate", "input_schema_invalid")
            return "denied"
        if not self.is_bound(tool["id"]):
            deny("validate", "capability_missing", {"kind": "channel_unbound", "channel": tool.get("channel") or "world"})
            return "denied"
        self.emit({"stage": "validate", "verdict": "allow", "tool": name, "args": args})

        # authorize (§6.2)
        gated_ok, gated_verdict = self.eval_gates({"action": act, "state": self.agent["state"]}, self.agent.get("gates"))
        if not gated_ok:
            deny("authorize", "gate_denied", None, gated_verdict)
            if gated_verdict == "safe_state":
                if origin == "recovery" or self.recovering:
                    return "denied"
                self.safe_flow("gate_denied")
                return "safe_state"
            return "denied"

        spawn_packet = None
        if name == SPAWN_TOOL:
            s_ok, s_reason, s_value = self.check_spawn(args)
            if not s_ok:
                deny("authorize", s_reason, s_value)
                return "denied"
            spawn_packet = s_value

        contract_effect = None
        if reflection:
            c_ok, c_reason, c_value = self.check_contract_tool(act)
            if not c_ok:
                self.note_reflection_denial(name)
                deny("authorize", c_reason, {"kind": "harness_patch", "code": c_value})
                return "denied"
            contract_effect = c_value

        seq_failure = self.check_sequences(act)
        if seq_failure is not None:
            deny("authorize", "sequence_requirement_failed", seq_failure)
            return "denied"
        comp_failure = self.check_completion(name)
        if comp_failure is not None:
            deny("authorize", "completion_gate_failed", comp_failure)
            return "denied"
        cp_key = self.check_checkpoint_request(act)
        if cp_key is not None:
            deny("authorize", "checkpoint_authority_failed", {"kind": "checkpoint_key", "checkpoint_key": cp_key})
            return "denied"
        if self.tool_calls >= self.max_tool_calls():
            deny("authorize", "limit_exceeded")
            return "denied"
        self.emit({"stage": "authorize", "verdict": "allow", "tool": name, "args": args})

        # execute (§6.3)
        self.tool_calls += 1
        invoked = self.invoke(name, args)
        if not invoked["ok"]:
            e = {"stage": "execute", "verdict": "deny", "reason": "infra_failure" if invoked["infra"] else "tool_execution_failed", "tool": name, "args": args, "failure": invoked["failure"]}
            if "error" in invoked:
                e["error"] = invoked["error"]
            self.emit(e)
            if invoked["infra"]:
                self.infra_failed = True
                return "infra"
            return "denied"
        env = read_envelope(invoked["raw"])
        if env is None:
            deny("execute", "output_schema_invalid", {"kind": "malformed_envelope"})
            return "denied"
        raw_output, raw_transition = env
        o_ok, out_c, o_path = to_canonical(raw_output, "$.result")
        if not o_ok:
            deny("execute", "output_schema_invalid", {"kind": "non_canonical", "path": o_path})
            return "denied"
        transition = None
        if raw_transition is not None:
            t_ok, t_c, t_path = to_canonical(raw_transition, "$.state_transition")
            if not t_ok:
                deny("execute", "output_schema_invalid", {"kind": "non_canonical", "path": t_path})
                return "denied"
            transition = t_c
        output = self.sanitize(out_c)
        out_ok, _ = _validate_schema(tool.get("output"), output)
        if not out_ok:
            deny("execute", "output_schema_invalid")
            return "denied"
        transition = self.with_declared_effects(tool, act, output, transition)
        authority = self.check_transition_authority(name, transition)
        if authority is not None:
            deny("execute", authority[0], authority[1])
            return "denied"

        pre_state = self.agent["state"]
        self.agent["state"] = self.apply_transition(pre_state, transition)
        self.emit({"stage": "execute", "verdict": "allow", "tool": name, "args": args, "result": output})

        if spawn_packet is not None and spawn_packet.get("proposals"):
            if self.run_child(spawn_packet, f"spawn-{self.seq}"):
                self.agent["state"] = pre_state
                self.infra_failed = True
                return "infra"

        # verify (§6.4)
        verifies = list(tool.get("verify") or [])
        recovery = self.agent.get("recovery") or {}
        if origin == "recovery" and recovery.get("verify"):
            verifies.append(recovery["verify"])
        if len(verifies) == 0:
            self.emit({"stage": "verify", "verdict": "allow"})
        for v in verifies:
            r = self.evaluate_verify(v, act, output)
            if r["pass"]:
                self.emit(r["event"])
                continue
            self.agent["state"] = pre_state  # discard the provisional transition (D8)
            self.emit(r["event"])
            if r.get("infra"):
                self.infra_failed = True
                return "infra"
            if r["verdict"] == "safe_state" and origin != "recovery" and not self.recovering:
                self.safe_flow(r["event"]["reason"])
                return "safe_state"
            return "denied"

        # commit (§6.5)
        self.commit_provenance(transition)
        self.succeeded.add(name)
        if contract_effect is not None:
            self.apply_contract_effect(act, contract_effect)
        self.apply_action_invalidation(name)
        if origin != "recovery" and (self._cb().get("completion") or {}).get("tool") == name:
            self.emit({"stage": "record", "verdict": "allow", "reason": "run_complete", "tool": name})
            return "complete"
        return "success"

    # ---------------------------------------------------------------- authorize helpers

    def eval_gates(self, snap: dict[str, Any], gates: Any) -> tuple[bool, str]:
        for g in gates or []:
            if g.get("when") is not None and not eval_predicate(g["when"], snap):
                continue
            if not eval_predicate(g["require"], snap):
                return False, "safe_state" if g.get("otherwise") == "safe_state" else "deny"
        return True, ""

    def check_spawn(self, args: dict[str, Any]) -> tuple[bool, str, Any]:
        spawn = self.agent.get("spawn") or {}
        if spawn.get("allow") is not True:
            return False, "gate_denied", spawn_failure("not_allowed")
        packet = parse_spawn_packet(args)
        if packet is None:
            return False, "schema_invalid", spawn_failure("malformed")

        def esc(dim: str) -> tuple[bool, str, Any]:
            return False, "gate_denied", spawn_failure("escalation", dim)

        if any(not self.is_permitted(t) for t in packet["tools"]):
            return esc("tools")
        fs = (self.agent.get("permissions") or {}).get("filesystem") or {}

        def covered(child: str, parents: Any) -> bool:
            c_ok, c = parse_scope(child)
            if not c_ok:
                return False
            for p in parents or []:
                p_ok, ps = parse_scope(p)
                if p_ok and scope_contains(ps, c):
                    return True
            return False

        if "write_scopes" in packet and any(not covered(s, fs.get("write_scopes")) for s in packet["write_scopes"]):
            return esc("write_scopes")
        if "read_scopes" in packet and fs.get("read_scopes") is not None and any(not covered(s, fs["read_scopes"]) for s in packet["read_scopes"]):
            return esc("read_scopes")
        if "max_steps" in packet and packet["max_steps"] > self.effective_max_steps() - self.steps:
            return esc("max_steps")
        if "max_tool_calls" in packet and packet["max_tool_calls"] > self.max_tool_calls() - self.tool_calls - 1:
            return esc("max_tool_calls")
        if packet["nested"] and spawn.get("allow_nested") is not True:
            return esc("nested")
        return True, "", packet

    def note_reflection_denial(self, tool: str) -> None:
        self.reflection_denials[tool] = self.reflection_denials.get(tool, 0) + 1

    def check_contract_tool(self, act: dict[str, Any]) -> tuple[bool, str, Any]:
        def invalid(code: str) -> tuple[bool, str, Any]:
            return False, "harness_patch_invalid", code

        if any(t in self.succeeded for t in REFLECTION_TOOLS):
            return invalid("reflection_done")
        if self.reflection_denials.get(act["name"], 0) >= 1:
            return invalid("attempt_cap")
        args = act["args"]
        if act["name"] == DECLINE_TOOL:
            d = parse_decline(args)
            if d is None:
                return invalid("invalid_decline")
            return True, "", {"kind": "decline", "reason": d["reason"], "note": d.get("note")}
        from_reflect = False
        if act["name"] == REFLECT_TOOL:
            disp = args.get("disposition")
            if disp == "decline":
                d = parse_decline(args)
                if d is None:
                    return invalid("invalid_decline")
                return True, "", {"kind": "decline", "reason": d["reason"], "note": d.get("note"), "reflect": True}
            if disp != "propose":
                return invalid("invalid_disposition")
            patch = parse_patch(args)
            if patch is None:
                return invalid("malformed_patch")
            from_reflect = True
        else:
            patch = parse_patch(args)
            if patch is None:
                return invalid("malformed_patch")
        ok, reason, code = validate_patch_security(self.agent, patch)
        if not ok:
            return False, reason, code
        return True, "", {"kind": "patch", "patch": patch, "reflect": from_reflect}

    def check_sequences(self, act: dict[str, Any]) -> dict[str, Any] | None:
        snap = {"action": act, "state": self.agent["state"]}
        for seq in self._cb().get("sequences") or []:
            if seq.get("action") != act["name"]:
                continue
            missing = [t for t in seq.get("require_prior_tools") or [] if t not in self.succeeded]
            if missing:
                return {"kind": "missing_prior_tools", "missing_prior_tools": sort_cp(missing)}
            any_of = seq.get("require_prior_any_of") or []
            if any_of and not any(t in self.succeeded for t in any_of):
                return {"kind": "missing_prior_any_of", "options": sort_cp(any_of)}
            rs = seq.get("require_state")
            if rs is not None and not eval_predicate(rs, snap):
                return build_predicate_failure(rs, snap, self.checkpoints())
        return None

    def check_completion(self, name: str) -> dict[str, Any] | None:
        completion = self._cb().get("completion")
        if completion is None or completion.get("tool") != name or completion.get("require") is None:
            return None
        action: dict[str, Any] = {"args": {}} if name is None else {"name": name, "args": {}}
        snap = {"action": action, "state": self.agent["state"]}
        if eval_predicate(completion["require"], snap):
            return None
        return build_predicate_failure(completion["require"], snap, self.checkpoints())

    def check_checkpoint_request(self, act: dict[str, Any]) -> str | None:
        cp = next((c for c in self.checkpoints() if c.get("tool") == act["name"]), None)
        if cp is None or not isinstance(act["args"].get("set"), dict):
            return None
        for key in sort_cp(act["args"]["set"].keys()):
            if key not in (cp.get("allow_set_keys") or []):
                return key
        return None

    def check_transition_authority(self, tool_id: str, transition: dict[str, Any] | None) -> tuple[str, dict[str, Any]] | None:
        if not transition:
            return None
        keys = sort_cp((transition.get("set") or {}).keys()) + list(transition.get("remove") or [])
        own = next((c for c in self.checkpoints() if c.get("tool") == tool_id), None)
        for key in keys:
            if key not in self.declared_keys:
                return "state_write_denied", {"kind": "state_key", "state_key": key}
            if own is not None:
                if key not in (own.get("allow_set_keys") or []):
                    return "checkpoint_authority_failed", {"kind": "checkpoint_key", "checkpoint_key": key}
            elif any(key in (c.get("allow_set_keys") or []) for c in self.checkpoints()):
                return "checkpoint_authority_failed", {"kind": "checkpoint_key", "checkpoint_key": key}
        return None

    def with_declared_effects(self, tool: dict[str, Any], act: dict[str, Any], result: dict[str, Any], transition: dict[str, Any] | None) -> dict[str, Any] | None:
        effects = tool.get("effects") or []
        if not effects:
            return transition
        snap = {"action": act, "state": self.agent["state"], "result": result}
        sset = dict(transition["set"]) if transition and transition.get("set") is not None else None
        for eff in effects:
            if eff.get("when") is not None and not eval_predicate(eff["when"], snap):
                continue
            sset = {**(sset or {}), **copy.deepcopy(eff["set"])}
        if sset is None:
            return transition
        return {**(transition or {}), "set": sset}

    # ---------------------------------------------------------------- state & provenance (§8.4)

    def apply_transition(self, state: dict[str, Any], transition: dict[str, Any] | None) -> dict[str, Any]:
        if not transition:
            return state
        nxt = dict(state)
        for k, v in (transition.get("set") or {}).items():
            nxt[k] = v
        for k in transition.get("remove") or []:
            nxt.pop(k, None)
        return nxt

    def commit_provenance(self, transition: dict[str, Any] | None) -> None:
        if not transition:
            return
        for k, v in (transition.get("set") or {}).items():
            self.provenance[k] = {"status": "current" if _is_fresh(v) else "stale", "updated_at_step": self.steps}
        for k in transition.get("remove") or []:
            self.provenance[k] = {"status": "stale", "updated_at_step": self.steps}

    def mark_stale(self, keys: list[str]) -> None:
        nxt = dict(self.agent["state"])
        for k in keys:
            nxt[k] = 0
            self.provenance[k] = {"status": "stale", "updated_at_step": self.steps}
        self.agent["state"] = nxt

    def apply_action_invalidation(self, action_name: str) -> None:
        keys: list[str] = []
        matched = False
        for rule in self._cb().get("invalidate_after") or []:
            if rule.get("action") != action_name:
                continue
            matched = True
            for k in rule.get("memory_keys") or []:
                if k not in keys:
                    keys.append(k)
        if not matched:
            return
        self.mark_stale(keys)
        self.emit({"stage": "record", "verdict": "allow", "reason": "memory_stale", "tool": action_name, "result": {"invalidated": sort_cp(keys)}})

    def apply_ttl_invalidation(self) -> None:
        for rule in self._cb().get("invalidate_after") or []:
            n = rule.get("ttl_steps")
            if "action" in rule or not _is_int(n) or n < 1:
                continue
            due = []
            for k in rule.get("memory_keys") or []:
                p = self.provenance.get(k)
                if p is not None and p["status"] == "current" and self.steps - p["updated_at_step"] > n:
                    due.append(k)
            if not due:
                continue
            keys = list(dict.fromkeys(due))
            self.mark_stale(keys)
            self.emit({"stage": "record", "verdict": "allow", "reason": "memory_stale", "result": {"invalidated": sort_cp(keys), "ttl_steps": n}})

    def check_intervention_budget(self) -> None:
        budget = self._cb().get("intervention_budget")
        if not budget or self.budget_emitted:
            return
        if (budget.get("window") or "run") != "run":
            return
        ma = budget.get("max_activations")
        if not _is_int(ma) or ma < 1:
            return
        if self.steps > ma:
            self.budget_emitted = True
            self.emit({"stage": "record", "verdict": "allow", "reason": "budget_exceeded", "result": {"max_activations": ma, "activations": self.steps, "window": "run"}})

    # ---------------------------------------------------------------- orientation (§8.5)

    def build_orientation_frame(self) -> dict[str, Any]:
        cb = self._cb()
        blockers = []
        for s in cb.get("sequences") or []:
            prior = s.get("require_prior_tools") or []
            any_of = s.get("require_prior_any_of") or []
            if not prior and not any_of:
                continue
            missing_prior = sort_cp([t for t in prior if t not in self.succeeded])
            missing_any = sort_cp(any_of) if any_of and not any(t in self.succeeded for t in any_of) else []
            if not missing_prior and not missing_any:
                continue
            b: dict[str, Any] = {"action": s.get("action")}
            if missing_prior:
                b["missing_prior_tools"] = missing_prior
            if missing_any:
                b["missing_prior_any_of"] = missing_any
            blockers.append(b)
        freshness: dict[str, int] = {}
        for rule in cb.get("invalidate_after") or []:
            for key in rule.get("memory_keys") or []:
                freshness[key] = 1 if (self.provenance.get(key) or {}).get("status") == "current" else 0
        frame: dict[str, Any] = {"permitted_tools": self.permitted_tools(), "sequence_blockers": blockers, "freshness": freshness}
        completion = cb.get("completion")
        if completion is not None:
            paths: list[str] = []
            self.collect_paths(completion.get("require"), paths)
            comp: dict[str, Any] = {
                "require_paths": sort_cp(set(paths)),
                "ready": 1 if self.check_completion(completion.get("tool")) is None else 0,
            }
            if completion.get("tool") is not None:
                comp["tool"] = completion["tool"]
            frame["completion"] = comp
        return frame

    def collect_paths(self, p: Any, out: list[str]) -> None:
        if not p:
            return
        if "path" in p:
            out.append(p["path"])
        for x in p.get("all") or []:
            self.collect_paths(x, out)
        for x in p.get("any") or []:
            self.collect_paths(x, out)
        if "not" in p:
            self.collect_paths(p["not"], out)

    # ---------------------------------------------------------------- verifies (§7)

    def evaluate_verify(self, v: dict[str, Any], act: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
        tool = act["name"]
        args = act["args"]
        state = self.agent["state"]
        kind = v.get("kind")
        fallback = "deny" if kind in ("output", "judge") else "safe_state"
        verdict = v["otherwise"] if v.get("otherwise") in ("deny", "safe_state") else fallback

        if kind == "effect":
            obs = self.run_observation(v.get("observe"))
            if not obs["ok"] and obs.get("infra"):
                return {"pass": False, "verdict": "deny", "infra": True, "event": {"stage": "verify", "verdict": "deny", "reason": "infra_failure", "tool": tool, "args": args, "failure": obs["infra"]}}
            if not obs["ok"]:
                return {"pass": False, "verdict": verdict, "event": {"stage": "verify", "verdict": verdict, "reason": "verify_effect_failed", "tool": tool, "args": args, "failure": {"kind": "observation_failed"}}}
            snap = {"action": act, "state": state, "result": result, "observation": obs["observation"]}
            if not eval_predicate(v["require"], snap):
                return {"pass": False, "verdict": verdict, "event": {"stage": "verify", "verdict": verdict, "reason": "verify_effect_failed", "tool": tool, "args": args, "observation": obs["observation"]}}
            return {"pass": True, "event": {"stage": "verify", "verdict": "allow", "tool": tool, "observation": obs["observation"]}}

        if kind == "output":
            msg = args.get("message")
            content = msg if isinstance(msg, str) else (result.get("message") if isinstance(result.get("message"), str) else "")
            snap = {"action": act, "state": state, "result": result, "message": build_message_snapshot(content)}
            observation = self.message_observation(content)
            if not eval_predicate(v["require"], snap):
                return {"pass": False, "verdict": verdict, "event": {"stage": "verify", "verdict": verdict, "reason": "verify_output_failed", "tool": tool, "args": args, "result": result, "observation": observation}}
            return {"pass": True, "event": {"stage": "verify", "verdict": "allow", "tool": tool, "result": result, "observation": observation}}

        if kind == "judge":
            if not self.allow_judge or self.judge is None:
                return {"pass": False, "verdict": verdict, "event": {"stage": "verify", "verdict": verdict, "reason": "verify_judge_invalid", "tool": tool, "args": args, "failure": {"kind": "judge", "code": "unavailable"}}}
            raw = self.judge(v.get("rubric"), {"action": act, "result": result, "state": state})
            j_ok, value, raw_text = self.read_judgment(raw)
            if not j_ok:
                ev = {"stage": "verify", "verdict": verdict, "reason": "verify_judge_invalid", "tool": tool, "args": args, "failure": {"kind": "judge", "code": "invalid"}}
                if raw_text is not None:
                    ev["error"] = excerpt(raw_text, EXCERPT_CHARS)
                return {"pass": False, "verdict": verdict, "event": ev}
            snap = {"action": act, "state": state, "result": result, "judgment": value}
            if not eval_predicate(v["require"], snap):
                return {"pass": False, "verdict": verdict, "event": {"stage": "verify", "verdict": verdict, "reason": "verify_judge_failed", "tool": tool, "args": args, "result": value}}
            return {"pass": True, "event": {"stage": "verify", "verdict": "allow", "tool": tool, "result": value}}

        reason = "verify_evidence_failed" if kind == "evidence" else "verify_absence_failed"
        snap = {"action": act, "state": state, "result": result}
        if not eval_predicate(v["require"], snap):
            return {"pass": False, "verdict": verdict, "event": {"stage": "verify", "verdict": verdict, "reason": reason, "tool": tool, "args": args, "result": result}}
        return {"pass": True, "event": {"stage": "verify", "verdict": "allow", "tool": tool, "result": result}}

    def read_judgment(self, raw: Any) -> tuple[bool, Any, str | None]:
        if isinstance(raw, dict) and raw.get("invalid") is True:
            return False, None, raw["raw"] if isinstance(raw.get("raw"), str) else None
        if not isinstance(raw, dict):
            return False, None, None
        score, reason = raw.get("score"), raw.get("reason")
        ok, sc, _ = to_canonical(score)
        if not isinstance(reason, str) or not ok or not _is_int(sc):
            return False, None, None
        return True, {"score": sc, "reason": excerpt(reason, EXCERPT_CHARS)}, None

    def message_observation(self, content: str) -> dict[str, Any]:
        snap = build_message_snapshot(content)
        return {"message": {**snap, "content": excerpt(snap["content"], self.max_observation_chars())}}

    def run_agent_output_verifies(self, content: str) -> str | None:
        snap = {"state": self.agent["state"], "message": build_message_snapshot(content)}
        observation = self.message_observation(content)
        for v in self._cb().get("output_verifies") or []:
            if v.get("kind") != "output":
                continue
            if eval_predicate(v["require"], snap):
                self.emit({"stage": "verify", "verdict": "allow", "observation": observation})
                continue
            verdict = "safe_state" if v.get("otherwise") == "safe_state" else "deny"
            self.emit({"stage": "verify", "verdict": verdict, "reason": "verify_output_failed", "observation": observation})
            return verdict
        return None

    def run_observation(self, observer_id: Any) -> dict[str, Any]:
        observer = self.tool_by_id(observer_id) if isinstance(observer_id, str) else None
        if observer is None or observer.get("read_only") is not True or (observer.get("channel") or "world") != "world":
            self.emit({"stage": "validate", "verdict": "deny", "reason": "capability_missing", "tool": observer_id})
            return {"ok": False}
        in_ok, in_compile = _validate_schema(observer.get("input"), {})
        if not in_ok:
            self.emit({"stage": "validate", "verdict": "deny", "reason": "schema_invalid" if in_compile else "input_schema_invalid", "tool": observer_id})
            return {"ok": False}
        if not self.is_bound(observer_id):
            self.emit({"stage": "validate", "verdict": "deny", "reason": "capability_missing", "tool": observer_id, "failure": {"kind": "channel_unbound", "channel": "world"}})
            return {"ok": False}
        if not self.is_permitted(observer_id):
            self.emit({"stage": "authorize", "verdict": "deny", "reason": "capability_missing", "tool": observer_id})
            return {"ok": False}
        if self.tool_calls >= self.max_tool_calls():
            self.emit({"stage": "authorize", "verdict": "deny", "reason": "limit_exceeded", "tool": observer_id})
            return {"ok": False}
        self.tool_calls += 1
        invoked = self.invoke(observer_id, {})
        if not invoked["ok"]:
            e = {"stage": "observe", "verdict": "deny", "reason": "infra_failure" if invoked["infra"] else "tool_execution_failed", "tool": observer_id, "failure": invoked["failure"]}
            if "error" in invoked:
                e["error"] = invoked["error"]
            self.emit(e)
            return {"ok": False, "infra": invoked["failure"]} if invoked["infra"] else {"ok": False}
        env = read_envelope(invoked["raw"])
        if env is None:
            self.emit({"stage": "observe", "verdict": "deny", "reason": "output_schema_invalid", "tool": observer_id, "failure": {"kind": "malformed_envelope"}})
            return {"ok": False}
        ok, cval, path = to_canonical(env[0], "$.observation")
        if not ok:
            self.emit({"stage": "observe", "verdict": "deny", "reason": "output_schema_invalid", "tool": observer_id, "failure": {"kind": "non_canonical", "path": path}})
            return {"ok": False}
        observation = self.sanitize(cval)
        if not _validate_schema(observer.get("output"), observation)[0]:
            self.emit({"stage": "observe", "verdict": "deny", "reason": "output_schema_invalid", "tool": observer_id})
            return {"ok": False}
        self.emit({"stage": "observe", "verdict": "allow", "tool": observer_id, "args": {}, "result": observation})
        return {"ok": True, "observation": observation}

    # ---------------------------------------------------------------- contract tools (§12)

    def apply_contract_effect(self, act: dict[str, Any], effect: dict[str, Any]) -> None:
        if effect["kind"] == "patch":
            before = harness_ir_hash(self.agent, self.initial_state)
            apply_harness_patch(self.agent, effect["patch"])
            after = harness_ir_hash(self.agent, self.initial_state)
            obs: dict[str, Any] = {"ops": len(effect["patch"]["ops"])}
            if effect.get("reflect"):
                obs["disposition"] = "propose"
            self.emit({"stage": "rebalance", "verdict": "allow", "reason": "harness_patch_applied", "tool": act["name"], "args": act["args"], "harness_hash_before": before, "harness_hash_after": after, "observation": obs})
            return
        obs = {"reason": effect["reason"]}
        if effect.get("reflect"):
            obs["disposition"] = "decline"
        if effect.get("note") is not None:
            obs["note"] = effect["note"]
        self.emit({"stage": "record", "verdict": "allow", "reason": "harness_patch_declined", "tool": act["name"], "args": act["args"], "observation": obs})

    # ---------------------------------------------------------------- spawn (§10)

    def build_child_agent(self, packet: dict[str, Any]) -> dict[str, Any]:
        parent = self.agent
        remaining_steps = max(0, self.effective_max_steps() - self.steps)
        remaining_calls = max(0, self.max_tool_calls() - self.tool_calls)
        child_ids = set(packet["tools"])
        perms = parent.get("permissions") or {}
        fs = perms.get("filesystem") or {}
        filesystem: dict[str, Any] = {}
        write = packet.get("write_scopes", fs.get("write_scopes"))
        read = packet.get("read_scopes", fs.get("read_scopes"))
        if write is not None:
            filesystem["write_scopes"] = write
        if read is not None:
            filesystem["read_scopes"] = read
        cb = copy.deepcopy(parent["counterbalance"]) if parent.get("counterbalance") is not None else None
        if cb is not None:
            cb.pop("intervention_budget", None)
            cb.pop("triggers", None)
            if not cb:
                cb = None
        limits: dict[str, Any] = {
            "max_steps": packet.get("max_steps", remaining_steps),
            "max_tool_calls": packet.get("max_tool_calls", remaining_calls),
        }
        if (parent.get("limits") or {}).get("max_observation_chars") is not None:
            limits["max_observation_chars"] = parent["limits"]["max_observation_chars"]
        cperms: dict[str, Any] = {"tools": list(packet["tools"])}
        if filesystem:
            cperms["filesystem"] = filesystem
        if perms.get("secrets") is not None:
            cperms["secrets"] = copy.deepcopy(perms["secrets"])
        if perms.get("protected_paths") is not None:
            cperms["protected_paths"] = list(perms["protected_paths"])
        child: dict[str, Any] = {
            "spec": parent.get("spec"),
            "name": f"{parent.get('name')}/child",
            "state": copy.deepcopy(parent["state"]),
            "tools": copy.deepcopy([t for t in parent["tools"] if t.get("id") in child_ids]),
            "limits": limits,
            "permissions": cperms,
            "spawn": {"allow": (parent.get("spawn") or {}).get("allow_nested") is True, "allow_nested": False, "tighten_only": True},
        }
        if parent.get("gates") is not None:
            child["gates"] = copy.deepcopy(parent["gates"])
        if parent.get("fallback_state") is not None:
            child["fallback_state"] = copy.deepcopy(parent["fallback_state"])
        if parent.get("recovery") is not None:
            child["recovery"] = copy.deepcopy(parent["recovery"])
        if cb is not None:
            child["counterbalance"] = cb
        return child

    def run_child(self, packet: dict[str, Any], spawn_id: str) -> bool:
        child_agent = self.build_child_agent(packet)
        proposals = [to_proposal(p) for p in packet.get("proposals") or []]
        handlers = {}
        for tid in packet["tools"]:
            h = self.tools.get(tid) if hasattr(self.tools, "get") else None
            if callable(h):
                handlers[tid] = h
        child = FaustRuntime(
            child_agent,
            proposals,
            handlers,
            None,
            depth=self.depth + 1,
            spawn_id=spawn_id,
            parse_proposals=False,
            allow_judge=False,
            transcript=self.transcript,
        )
        child.run_loop()
        for cev in child.events:
            self.seq += 1
            self.events.append({**cev, "seq": self.seq, "ts_logical": self.seq})
        self.steps += child.steps
        self.tool_calls += child.tool_calls
        self.emit({"stage": "record", "verdict": "allow", "reason": "spawn_returned", "tool": SPAWN_TOOL, "result": {"events": len(child.events), "steps": child.steps, "tool_calls": child.tool_calls}})
        return child.infra_failed

    # ---------------------------------------------------------------- safe flow (§11)

    def apply_fallback_state(self) -> None:
        fb = self.agent.get("fallback_state") or self.agent.get("safe_state")
        if fb:
            self.agent["state"] = {**self.agent["state"], **fb}
        self.emit({"stage": "record", "verdict": "safe_state", "reason": "safe_state_entered"})

    def safe_flow(self, trigger: str) -> None:
        recovery = self.agent.get("recovery")
        if recovery and not self.recovering and (recovery.get("on") is None or recovery.get("on") == trigger):
            self.recovering = True
            try:
                ex = recovery.get("execute") or {}
                outcome = self.process_action({"name": ex.get("tool"), "args": ex.get("args") or {}}, "recovery")
            finally:
                self.recovering = False
            if outcome == "infra":
                return
            if outcome == "success":
                self.emit({"stage": "record", "verdict": "allow", "reason": "recovery_succeeded"})
            else:
                self.emit({"stage": "record", "verdict": "deny", "reason": "terminal_failure"})
        self.apply_fallback_state()


def events_to_jsonl(events: list[dict[str, Any]]) -> str:
    return "\n".join(canonical_json(e) for e in events) + "\n"
