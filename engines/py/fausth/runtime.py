"""Counterbalance runtime — Python twin of ``engines/ts/src/runtime.ts``.

Values follow JavaScript semantics wherever they can reach the event log
(``??``, truthiness, ``String()``/``Number()``, ``undefined`` vs ``null``) so
that both engines emit byte-identical canonical event logs.
"""
from __future__ import annotations

import copy
import hashlib
import math
from pathlib import Path
from typing import Any, Callable, Iterable

from .canonical import (
    UNDEFINED,
    canonical_json,
    deep_eq,
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


def scope_covered(child: str, parents: list[str]) -> bool:
    for p in parents:
        if p in (".", "./", "*", "**"):
            return True
        if child == p:
            return True
        prefix = p if p.endswith("/") else p + "/"
        if child.startswith(prefix) or child == (p[:-1] if p.endswith("/") else p):
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
        done: set[str] = set()
        for e in self.events:
            if e.get("stage") == "execute" and e.get("verdict") == "allow" and js_truthy(e.get("tool")):
                done.add(e["tool"])
        return done

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
        cb = nn(self.cb, {})
        # Can-only: advertise tools this harness actually declares — never blocked_tools / modes.
        permitted = js_sorted_strings([jget(t, "id") for t in self.agent.get("tools") or []])
        done = self.successful_executes()
        plan_approved = js_number(nn(self.state.get("plan_approved", UNDEFINED), 0)) == 1
        if plan_approved:
            permitted = [t for t in permitted if t != "user.approve"]
        sequence_blockers: list[dict[str, Any]] = []
        for s in js_array(nn(jget(cb, "sequences"), []), "sequences"):
            if not js_truthy(jprop(s, "action")):
                continue
            priors = jget(s, "require_prior_tools")
            options_raw = jget(s, "require_prior_any_of")
            if not js_truthy(jget(s, "action")):
                continue
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
        completion = jget(cb, "completion")
        require = jget(completion, "require")
        completion_paths = (
            sorted(set(self.collect_completion_paths(require))) if js_truthy(require) else []
        )
        ctool = jget(completion, "tool")
        ready = (
            self.check_completion(ctool)[0]
            if js_truthy(completion) and js_truthy(ctool)
            else True
        )
        frame: dict[str, Any] = {
            "permitted_tools": permitted,
            "tools": permitted,
            "sequence_blockers": sequence_blockers,
            "freshness": freshness,
            "completion": {
                "tool": nn(ctool, "task.complete"),
                "require_paths": completion_paths,
                "ready": 1 if ready else 0,
            },
        }
        if "plan_approved" in self.state:
            frame["plan"] = (
                {
                    "approved": 1,
                    "next_tool": "phase.yield",
                    "note": "Plan already approved — call phase.yield next. Do not call user.approve again.",
                }
                if plan_approved
                else {"approved": 0}
            )
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

    # -- memory / provenance --------------------------------------------------

    def apply_invalidate_after(self, action_name: str) -> None:
        rules = self.cb_get("invalidate_after")
        if not js_truthy(rules):
            return
        touched = False
        next_state = dict(self.state)
        for rule in js_iter(rules, "invalidate_after"):
            ra = jget(rule, "action")
            if not js_truthy(ra) or not js_strict_eq(ra, action_name):
                continue
            for key in js_iter(jprop(rule, "memory_keys"), "rule.memory_keys"):
                next_state[js_string(key)] = 0
                touched = True
                self.touch_provenance_stale(key)
        if not touched:
            return
        self.agent["state"] = next_state
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
        touched = False
        next_state = dict(self.state)
        for rule in js_iter(rules, "invalidate_after"):
            ttl = jget(rule, "ttl_steps")
            if js_truthy(jget(rule, "action")) or not js_truthy(ttl) or js_lt(ttl, 1):
                continue
            for key in js_iter(jprop(rule, "memory_keys"), "rule.memory_keys"):
                k = js_string(key)
                meta = jget(mp, k)
                updated = nn(jget(meta, "updated_at_step"), 0)
                if js_number(self.steps - js_number(updated)) < js_number(ttl):
                    continue
                if js_number(nn(next_state.get(k, UNDEFINED), 0)) == 0 and jget(meta, "status") == "stale":
                    continue
                next_state[k] = 0
                self.touch_provenance_stale(key)
                touched = True
        if not touched:
            return
        self.agent["state"] = next_state
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

    # -- completion / checkpoints -----------------------------------------------

    def completion_tool_id(self) -> Any:
        return nn(jget(self.cb_get("completion"), "tool"), "task.complete")

    def is_terminal_success_tool(self, name: Any) -> bool:
        return js_strict_eq(name, self.completion_tool_id()) or name == "phase.yield"

    def check_completion(self, action_name: Any) -> tuple[bool, str | None, dict[str, Any] | None]:
        completion = self.cb_get("completion")
        if not js_truthy(completion):
            return True, None, None
        tool = self.completion_tool_id()
        if not js_strict_eq(action_name, tool):
            return True, None, None
        req = jget(completion, "require")
        if not js_truthy(req):
            return True, None, None
        snap = {"action": {"name": action_name, "args": {}}, "state": self.state}
        if not eval_predicate(req, snap):
            checkpoints = nn(self.cb_get("checkpoints"), [])
            return False, "completion_gate_failed", build_predicate_failure(req, snap, checkpoints)
        return True, None, None

    def check_checkpoint_authority(
        self, action: dict[str, Any], transition: Any
    ) -> tuple[bool, str | None, str | None, dict[str, Any] | None]:
        policies = nn(self.cb_get("checkpoints"), [])
        policy = next((p for p in js_iter(policies, "checkpoints") if js_strict_eq(jget(p, "tool"), action["name"])), None)
        if policy is None:
            return True, None, None, None
        allowed = jget(policy, "allow_set_keys")
        allowed_set = set(js_iter(allowed, "allow_set_keys")) if not is_nullish(allowed) else set()
        requested = nn(jget(jprop_args(action), "set"), {})
        for key in js_object_keys(requested):
            if key not in allowed_set:
                return (
                    False,
                    "checkpoint_authority_failed",
                    f"checkpoint args attempted protected key '{key}'",
                    build_checkpoint_key_failure(key),
                )
        actual_set = nn(jget(transition, "set"), {})
        for key in js_object_keys(actual_set):
            if key not in allowed_set:
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
                    self.touch_provenance_fresh(k)
        tremove = jget(transition, "remove")
        if js_truthy(tremove):
            for k in js_iter(tremove, "transition.remove"):
                next_state.pop(js_string(k), None)
        self.agent["state"] = next_state

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
        if handler is None:
            raise RuntimeError(f"No native handler for {js_string(name)}")
        raw = handler(args, {"state": self.state})
        return normalize_envelope(UNDEFINED if raw is None else raw)

    def apply_fallback_state(self) -> None:
        fb = fallback_state_of(self.agent)
        if js_truthy(fb):
            self.agent["state"] = {**self.state, **js_spread(fb)}
        self.emit({"stage": "record", "verdict": "safe_state", "reason": "safe_state_entered"})

    # -- spawn ------------------------------------------------------------------

    def compare_child_envelope(self, args: Any) -> tuple[bool, str, Any]:
        spawn = self.agent.get("spawn", UNDEFINED)
        if jget(spawn, "allow") is False:
            return False, "gate_denied", "spawn.allow is false"
        if js_truthy(spawn) and jget(spawn, "allow") is not True and jget(spawn, "allow") is not UNDEFINED:
            return False, "gate_denied", UNDEFINED
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
        max_steps = nn(self.limits_get("max_steps"), 1000)
        max_tools = nn(self.limits_get("max_tool_calls"), 1000)
        remaining_steps = js_number(max_steps) - self.steps
        remaining_calls = js_number(max_tools) - self.tool_calls
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
        max_steps = js_number(nn(self.limits_get("max_steps"), 1000))
        max_tools = js_number(nn(self.limits_get("max_tool_calls"), 1000))
        remaining_steps = js_max(1, max_steps - self.steps)
        remaining_calls = js_max(1, max_tools - self.tool_calls)
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
        )
        child.run_loop(nn(jget(child_agent.get("limits"), "max_steps"), 32))
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
            self.emit(
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
            self.emit(
                {"stage": "authorize", "verdict": "deny", "reason": "capability_missing", "tool": observer_id}
            )
            return False, None
        max_tools = nn(self.limits_get("max_tool_calls"), 1000)
        if js_ge(self.tool_calls, max_tools):
            self.emit({"stage": "authorize", "verdict": "deny", "reason": "limit_exceeded", "tool": observer_id})
            return False, None
        self.tool_calls += 1
        try:
            envelope = self.invoke_native(observer_id, {})
        except Exception as e:
            self.emit(
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
        if not ok:
            self.emit(
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

    def run_recovery(self, trigger_reason: str) -> None:
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
        tool = self.tool_by_id(action["name"])
        if not tool:
            self.emit(
                {
                    "stage": "validate",
                    "verdict": "deny",
                    "reason": "capability_missing",
                    "tool": action["name"],
                    "args": action["args"],
                }
            )
            self._recovery_failed()
            return
        ok, _ = validate_against_schema(jget(tool, "input"), action["args"])
        if not ok:
            self.emit(
                {
                    "stage": "validate",
                    "verdict": "deny",
                    "reason": "input_schema_invalid",
                    "tool": action["name"],
                    "args": action["args"],
                    "error": "input schema validation failed",
                }
            )
            self._recovery_failed()
            return
        self.emit({"stage": "validate", "verdict": "allow", "tool": action["name"], "args": action["args"]})
        self.emit({"stage": "authorize", "verdict": "allow", "tool": action["name"], "args": action["args"]})
        self.tool_calls += 1
        try:
            envelope = self.invoke_native(action["name"], action["args"])
        except Exception as e:
            self.emit(
                {
                    "stage": "execute",
                    "verdict": "deny",
                    "reason": "tool_execution_failed",
                    "tool": action["name"],
                    "args": action["args"],
                    "error": str(e),
                }
            )
            self._recovery_failed()
            return
        ok, _ = validate_against_schema(jget(tool, "output"), envelope["output"])
        if not ok:
            self.emit(
                {
                    "stage": "execute",
                    "verdict": "deny",
                    "reason": "output_schema_invalid",
                    "tool": action["name"],
                    "args": action["args"],
                    "error": "output schema validation failed",
                }
            )
            self._recovery_failed()
            return
        self.apply_state_transition(envelope.get("state_transition", UNDEFINED))
        self.emit(
            {
                "stage": "execute",
                "verdict": "allow",
                "tool": action["name"],
                "args": action["args"],
                "result": envelope["output"],
            }
        )
        verified = self.run_one_verify(jprop(recovery, "verify"), action, envelope["output"])
        if verified:
            self.emit({"stage": "record", "verdict": "allow", "reason": "recovery_succeeded"})
        else:
            self.emit({"stage": "record", "verdict": "deny", "reason": "terminal_failure"})
        self.apply_fallback_state()
        self.recovering = False

    def _recovery_failed(self) -> None:
        self.emit({"stage": "record", "verdict": "deny", "reason": "terminal_failure"})
        self.apply_fallback_state()
        self.recovering = False

    def enter_safe_flow(self, trigger_reason: str) -> None:
        self.run_recovery(trigger_reason)

    def run_verifies(self, tool: dict[str, Any], action: dict[str, Any], result: Any) -> bool:
        verifies = nn(jget(tool, "verify"), [])
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
                self.emit(
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
            observation: dict[str, Any] = {}
            if kind == "evidence" and action["name"] == "shell.run_allowlisted":
                stdout = jprop(result, "stdout")
                stderr = jprop(result, "stderr")
                stdout = stdout if isinstance(stdout, str) else ""
                stderr = stderr if isinstance(stderr, str) else ""
                exit_code = jprop(result, "exit_code")
                if stdout:
                    observation["stdout"] = stdout[:8000]
                if stderr:
                    observation["stderr"] = stderr[:8000]
                if exit_code is not UNDEFINED:
                    observation["exit_code"] = exit_code
                err = jget(result, "error")
                if isinstance(err, str) and err:
                    observation["error"] = err
                observation["hint"] = (
                    "cmd=test failed verify_evidence. Read stdout/stderr above, "
                    "fix the approved source file, then re-run cmd=test."
                )
            payload: dict[str, Any] = {
                "stage": "verify",
                "verdict": verdict,
                "reason": reason,
                "tool": action["name"],
                "args": action["args"],
                "result": result,
            }
            if observation:
                payload["observation"] = observation
            self.emit(payload)
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
            self.emit(
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
            if ptype == "invalid":
                consecutive_empty += 1
                pmsg = proposal.get("message", UNDEFINED)
                preason = proposal.get("reason", UNDEFINED)
                self.emit(
                    {
                        "stage": "propose",
                        "verdict": "deny",
                        "reason": "empty_proposal",
                        "error": nn(pmsg, preason),
                        "observation": {
                            "invalid_reason": preason,
                            "stop_message": js_string(pmsg)[:500] if js_truthy(pmsg) else None,
                        },
                    }
                )
                # Cap empty-proposal thrash even when continue_after_deny is on.
                if self.deny_is_terminal() or consecutive_empty >= 2:
                    break
                continue
            consecutive_empty = 0

            action = {"name": jget(proposal, "name"), "args": jget(proposal, "args")}
            if not self._step(action):
                break
        return self.events

    def _step(self, action: dict[str, Any]) -> bool:
        """One governed tool step. Returns False when the loop must stop."""
        name = action["name"]
        self.emit({"stage": "propose", "tool": name, "args": action["args"]})
        tool = self.tool_by_id(name)
        if not tool:
            self._deny("validate", "capability_missing", action)
            return not self.deny_is_terminal()
        allowed = self.perms_get("tools")
        if js_truthy(allowed) and not js_includes(allowed, name) and name != "agent.spawn":
            self._deny("validate", "capability_missing", action)
            return not self.deny_is_terminal()
        ok, _ = validate_against_schema(jget(tool, "input"), action["args"])
        if not ok:
            if name in SKILLS_REFLECTION_TOOLS:
                self.note_reflection_attempt(name)
            self._deny("validate", "input_schema_invalid", action, error="input schema validation failed")
            return not self.deny_is_terminal()
        self.emit({"stage": "validate", "verdict": "allow", "tool": name, "args": action["args"]})

        gok, verdict, reason = self.eval_gates({"action": action, "state": self.state})
        if not gok:
            self.emit(
                {"stage": "authorize", "verdict": verdict, "reason": reason, "tool": name, "args": action["args"]}
            )
            if verdict == "safe_state":
                self.enter_safe_flow("gate_denied")
                return False
            return not self.deny_is_terminal()

        if name == "agent.spawn":
            cok, creason, cerr = self.compare_child_envelope(action["args"])
            if not cok:
                self._deny("authorize", creason, action, error=cerr)
                return not self.deny_is_terminal()

        if name in SKILLS_REFLECTION_TOOLS:
            rok, rerr = self.reflection_gate(name)
            if not rok:
                self.note_reflection_attempt(name)
                self._deny("authorize", "harness_patch_invalid", action, error=rerr)
                return not self.deny_is_terminal()

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
                return not self.deny_is_terminal()
            pok, preason, perr = validate_patch_security(self.agent, patch)
            if not pok:
                self.note_reflection_attempt(name)
                self._deny("authorize", preason, action, error=perr)
                return not self.deny_is_terminal()

        if name == "harness.decline_skills_patch":
            if not parse_skills_patch_decline(action["args"]):
                self.note_reflection_attempt(name)
                self._deny(
                    "authorize",
                    "harness_patch_invalid",
                    action,
                    error="decline requires reason in {no_new_heuristic,insufficient_evidence,would_overfit_task,skills_already_adequate}",
                )
                return not self.deny_is_terminal()

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
                return not self.deny_is_terminal()
            if reflect["disposition"] == "propose":
                pok, preason, perr = validate_patch_security(self.agent, reflect["patch"])
                if not pok:
                    self.note_reflection_attempt(name)
                    self._deny("authorize", preason, action, error=perr)
                    return not self.deny_is_terminal()

        sok, sreason, sfail = self.check_sequences(action)
        if not sok:
            self._deny("authorize", sreason, action, failure=sfail)
            return not self.deny_is_terminal()

        cok2, creason2, cfail2 = self.check_completion(name)
        if not cok2:
            self._deny("authorize", creason2, action, failure=cfail2)
            return not self.deny_is_terminal()

        self.emit({"stage": "authorize", "verdict": "allow", "tool": name, "args": action["args"]})
        self.tool_calls += 1
        try:
            envelope = self.invoke_native(name, action["args"])
        except Exception as e:
            self._deny("execute", "tool_execution_failed", action, error=str(e))
            return not self.deny_is_terminal()

        ok, _ = validate_against_schema(jget(tool, "output"), envelope["output"])
        if not ok:
            self._deny("execute", "output_schema_invalid", action, error="output schema validation failed")
            return not self.deny_is_terminal()

        transition = envelope.get("state_transition", UNDEFINED)
        cok3, creason3, cerr3, cfail3 = self.check_checkpoint_authority(action, transition)
        if not cok3:
            self._deny("execute", creason3, action, error=cerr3, failure=cfail3)
            return not self.deny_is_terminal()

        self.apply_state_transition(transition)
        self.emit(
            {"stage": "execute", "verdict": "allow", "tool": name, "args": action["args"], "result": envelope["output"]}
        )

        if name == "agent.spawn":
            spawn_id = f"spawn-{self.seq}"
            child_steps = self.run_nested_child(action["args"], spawn_id)
            if child_steps > 0:
                exec_ev = self.events[len(self.events) - 1 - child_steps]
                if exec_ev.get("stage") == "execute" and exec_ev.get("tool") == "agent.spawn":
                    exec_ev["result"] = {**js_spread(envelope["output"]), "child_events": child_steps}

        self._after_execute_harness_cells(name, action)

        if not self.run_verifies(tool, action, envelope["output"]):
            # CB: deliver the failed observation and let the model recover when
            # continue_after_deny is set — same as authorize denies.
            return not self.deny_is_terminal()

        self.apply_invalidate_after(name)
        # First successful terminal tool ends the run (avoid complete/yield spam).
        if self.is_terminal_success_tool(name):
            self.emit(
                {
                    "stage": "record",
                    "verdict": "allow",
                    "reason": "phase_yielded" if name == "phase.yield" else "run_complete",
                    "tool": name,
                }
            )
            return False
        return True

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
# --------------------------------------------------------------------------

SHELL_NOT_ALLOWLISTED_ERROR = (
    "not allowlisted: only 'test' and 'typecheck' are available; use fs.read/fs.list to explore"
)
GREET_HELLO = 'export function greet(){ return "hello"; }\n'
SECRET_FIXTURE_VALUE = "sk-fixture-secret-0001"


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


def _list_entries_in_memory(path: str, files: dict[str, str]) -> list[str]:
    normalized = path.replace("\\", "/")
    if normalized.endswith("/"):
        normalized = normalized[:-1]
    prefix = f"{normalized}/" if normalized else ""
    entries: set[str] = set()
    for key in files:
        if normalized and key != normalized and not key.startswith(prefix):
            continue
        if not normalized:
            name = key.split("/")[0]
            if name:
                entries.add(name)
            continue
        rest = key[len(prefix):]
        name = rest.split("/")[0]
        if name:
            entries.add(name)
    return sorted(entries)


def _in_scope(path: str, scopes: Any) -> bool:
    for s in js_iter(scopes, "scopes"):
        if s in (".", "./", "*", "**"):
            return True
        if path == s or path.startswith(s if s.endswith("/") else s + "/"):
            return True
    return False


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


def init_coding_secrets(world: dict[str, Any], secrets: Any) -> None:
    if not js_truthy(secrets):
        return
    world["secret_paths"] = list(nn(jget(secrets, "paths"), []))
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
    world["protected_paths"] = list(paths)
    world["protected_baseline"] = {p: world["files"].get(p) for p in paths}


def coding_world_from_agent(
    agent: dict[str, Any],
    *,
    test_exit: int | None = None,
    files: dict[str, str] | None = None,
) -> dict[str, Any]:
    perms = agent.get("permissions", UNDEFINED)
    fs = jget(perms, "filesystem")
    world: dict[str, Any] = {
        "files": files
        if files is not None
        else {"src/app.ts": "export {}", "src/app.js": 'export function greet(){ return "hi"; }\n'},
        "write_scopes": nn(jget(fs, "write_scopes"), ["src/"]),
        "read_scopes": jget(fs, "read_scopes"),
        "last_exit_code": nn(test_exit, 1),
        "out_of_scope_writes": 0,
    }
    init_coding_secrets(world, jget(perms, "secrets"))
    init_coding_protected_paths(world, jget(perms, "protected_paths"))
    return world


def create_coding_tools(world: dict[str, Any]) -> dict[str, ToolHandler]:
    def read_scopes() -> Any:
        return nn(world.get("read_scopes", UNDEFINED), world["write_scopes"])

    def fs_read(args: Any, ctx: dict[str, Any]) -> dict[str, Any]:
        path = js_string(jprop(args, "path"))
        scopes = read_scopes()
        if len(scopes) > 0 and not _in_scope(path, scopes):
            return {"output": {"path": path, "content": "", "found": 0, "error": "scope_denied"}}
        content = world["files"].get(path, "")
        found = 1 if path in world["files"] else 0
        if found and path in (world.get("secret_paths") or []):
            _register_secret_value(world, content)
        return {"output": {"path": path, "content": content, "found": found}}

    def fs_list(args: Any, ctx: dict[str, Any]) -> dict[str, Any]:
        path = js_string(jprop(args, "path"))
        scopes = read_scopes()
        if len(scopes) > 0 and not _in_scope(path, scopes):
            return {"output": {"path": path, "entries": [], "found": 0, "error": "scope_denied"}}
        entries = _list_entries_in_memory(path, world["files"])
        return {"output": {"path": path, "entries": entries, "found": 1 if entries else 0}}

    def fs_write(args: Any, ctx: dict[str, Any]) -> dict[str, Any]:
        path = js_string(jprop(args, "path"))
        content = js_string(nn(jprop(args, "content"), ""))
        allowed = _in_scope(path, world["write_scopes"])
        leak_check = _should_deny_write_contains(world)
        if not allowed:
            world["out_of_scope_writes"] += 1
            out: dict[str, Any] = {"ok": 0, "out_of_scope": 1, "path": path}
            if leak_check:
                out["secret_leak"] = 0
            out.update(_protect_flags(world))
            return {"output": out, "state_transition": {"set": {"out_of_scope_writes": world["out_of_scope_writes"]}}}
        if _protection_active(world) and path in world["protected_paths"]:
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
        if cmd in ("test", "typecheck"):
            code = world["last_exit_code"]
            if restore_protected_paths(world):
                return {"output": {"exit_code": code, "cmd": cmd, "protected_modified": 1}}
            out: dict[str, Any] = {"exit_code": code, "cmd": cmd}
            if protect:
                out["protected_modified"] = 0
            result: dict[str, Any] = {"output": out}
            if code == 0:
                result["state_transition"] = {"set": {"test_evidence_current": 1}}
            return result
        out_deny: dict[str, Any] = {"exit_code": 1, "cmd": cmd, "error": SHELL_NOT_ALLOWLISTED_ERROR}
        if protect:
            out_deny["protected_modified"] = 0
        return {"output": out_deny}

    def user_ask(args: Any, ctx: dict[str, Any]) -> dict[str, Any]:
        answer = nn(jprop(args, "answer"), nn(jprop(args, "question"), ""))
        return {"output": {"answer": js_string(answer)}, "state_transition": {"set": {"clarified": 1}}}

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

    return {
        "fs.read": fs_read,
        "fs.list": fs_list,
        "fs.write_scoped": fs_write,
        "shell.run_allowlisted": shell,
        "user.approve": lambda a, c: {"output": {"approved": 0}},
        "user.ask": user_ask,
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
    exit_codes: dict[str, int] | None = None,
) -> dict[str, ToolHandler]:
    """TS ``createSimulationCodingAdapter`` (deterministic fake FS/shell)."""
    world: dict[str, Any] = {
        "files": {"src/app.ts": "export {}", **(files or {})},
        "write_scopes": nn(write_scopes, ["src/"]),
        "last_exit_code": 0,
        "out_of_scope_writes": 0,
    }
    base = create_coding_tools(world)
    codes = exit_codes or {}

    def shell(args: Any, ctx: dict[str, Any]) -> dict[str, Any]:
        cmd = js_string(jprop(args, "cmd"))
        fallback = world["last_exit_code"] if cmd in ("test", "typecheck") else 1
        code = codes.get(cmd, fallback)
        if cmd in ("test", "typecheck") or cmd in codes:
            return {"output": {"exit_code": code, "cmd": cmd}}
        return {"output": {"exit_code": 1, "cmd": cmd, "error": SHELL_NOT_ALLOWLISTED_ERROR}}

    return {**base, "shell.run_allowlisted": shell}


def simulation_tool_pool(
    agent: dict[str, Any],
    *,
    test_exit: int | None = None,
    sensor_healthy: int | None = None,
    files: dict[str, str] | None = None,
) -> dict[str, ToolHandler]:
    """Deployment handler pool — TS ``adapters/registry.ts buildHandlerPool``."""
    write_scopes = nn(jget(jget(agent.get("permissions", UNDEFINED), "filesystem"), "write_scopes"), ["src/"])
    coding = create_simulation_coding_tools(
        files=files,
        write_scopes=write_scopes,
        exit_codes={"test": test_exit, "typecheck": test_exit} if test_exit is not None else None,
    )
    if test_exit is not None:

        def shell(args: Any, ctx: dict[str, Any]) -> dict[str, Any]:
            cmd = js_string(jprop(args, "cmd"))
            if cmd in ("test", "typecheck"):
                return {"output": {"exit_code": test_exit, "cmd": cmd}}
            return {"output": {"exit_code": 1, "cmd": cmd, "error": SHELL_NOT_ALLOWLISTED_ERROR}}

        coding["shell.run_allowlisted"] = shell
    return {
        **create_greenhouse_tools(_greenhouse_world(agent, sensor_healthy)),
        **coding,
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
