from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any, Callable

from .canonical import canonical_json, deep_eq, state_hash
from .predicates import eval_predicate
from .schema_validate import validate_against_schema

ToolHandler = Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]]


def fallback_state_of(agent: dict[str, Any]) -> dict[str, Any] | None:
    return agent.get("fallback_state") or agent.get("safe_state")


def normalize_envelope(raw: dict[str, Any]) -> dict[str, Any]:
    if isinstance(raw, dict) and "output" in raw and isinstance(raw["output"], dict):
        return raw
    if isinstance(raw, dict) and "_state_patch" in raw:
        raise RuntimeError("_state_patch is forbidden; use state_transition")
    return {"output": raw}


def scope_covered(child: str, parents: list[str]) -> bool:
    for p in parents:
        if child == p:
            return True
        prefix = p if p.endswith("/") else p + "/"
        if child.startswith(prefix):
            return True
    return False


class FaustRuntime:
    def __init__(
        self,
        agent: dict[str, Any],
        proposals: list[dict[str, Any]],
        tools: dict[str, ToolHandler],
        recorded_tool_results: list[dict[str, Any]] | None = None,
    ) -> None:
        self.agent = copy.deepcopy(agent)
        if self.agent.get("safe_state") and not self.agent.get("fallback_state"):
            self.agent["fallback_state"] = self.agent["safe_state"]
        self.proposals = proposals
        self.pi = 0
        self.tools = tools
        self.recorded = recorded_tool_results or []
        self.ri = 0
        self.events: list[dict[str, Any]] = []
        self.seq = 0
        self.steps = 0
        self.tool_calls = 0
        self.recovering = False

    def emit(self, partial: dict[str, Any]) -> dict[str, Any]:
        self.seq += 1
        ev = {
            "seq": self.seq,
            "ts_logical": self.seq,
            "state_hash": partial.get("state_hash") or state_hash(self.agent["state"]),
            "stage": partial["stage"],
        }
        for k in ("verdict", "reason", "tool", "args", "result", "observation", "error"):
            if k in partial and partial[k] is not None:
                ev[k] = partial[k]
        self.events.append(ev)
        return ev

    def tool_by_id(self, tid: str) -> dict[str, Any] | None:
        for t in self.agent.get("tools", []):
            if t["id"] == tid:
                return t
        return None

    def parent_tools(self) -> list[str]:
        perms = (self.agent.get("permissions") or {}).get("tools")
        if perms is not None:
            return list(perms)
        return [t["id"] for t in self.agent.get("tools", [])]

    def check_limits(self) -> bool:
        limits = self.agent.get("limits") or {}
        max_steps = limits.get("max_steps", 1000)
        max_tools = limits.get("max_tool_calls", 1000)
        if self.steps >= max_steps or self.tool_calls >= max_tools:
            self.emit({"stage": "authorize", "verdict": "deny", "reason": "limit_exceeded"})
            return False
        return True

    def eval_gates(self, snapshot: dict[str, Any]) -> tuple[bool, str | None, str | None]:
        for g in self.agent.get("gates") or []:
            when = g.get("when")
            if when and not eval_predicate(when, snapshot):
                continue
            if not eval_predicate(g["require"], snapshot):
                return False, g.get("otherwise", "deny"), "gate_denied"
        return True, None, None

    def successful_executes(self) -> set[str]:
        done: set[str] = set()
        for e in self.events:
            if e.get("stage") == "execute" and e.get("verdict") == "allow" and e.get("tool"):
                done.add(str(e["tool"]))
        return done

    def check_mode(self, action_name: str) -> tuple[bool, str | None]:
        modes = (self.agent.get("counterbalance") or {}).get("modes") or []
        if not modes:
            return True, None
        mode_id = str(self.agent["state"].get("mode", ""))
        mode = next((m for m in modes if m.get("id") == mode_id), None)
        if not mode:
            return False, "mode_denied"
        tools = mode.get("tools")
        if tools is not None and action_name not in tools:
            return False, "mode_denied"
        return True, None

    def check_sequences(self, action: dict[str, Any]) -> tuple[bool, str | None]:
        seqs = (self.agent.get("counterbalance") or {}).get("sequences") or []
        if not seqs:
            return True, None
        done = self.successful_executes()
        snap = {"action": action, "state": self.agent["state"]}
        for seq in seqs:
            if seq.get("action") != action["name"]:
                continue
            for prior in seq.get("require_prior_tools") or []:
                if prior not in done:
                    return False, "sequence_requirement_failed"
            req = seq.get("require_state")
            if req and not eval_predicate(req, snap):
                return False, "sequence_requirement_failed"
        return True, None

    def apply_invalidate_after(self, action_name: str) -> None:
        rules = (self.agent.get("counterbalance") or {}).get("invalidate_after") or []
        touched = False
        next_state = dict(self.agent["state"])
        for rule in rules:
            if rule.get("action") != action_name:
                continue
            for key in rule.get("memory_keys") or []:
                next_state[key] = 0
                touched = True
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

    def check_completion(self, action_name: str) -> tuple[bool, str | None]:
        completion = (self.agent.get("counterbalance") or {}).get("completion") or {}
        if not completion:
            return True, None
        tool = completion.get("tool") or "task.complete"
        if action_name != tool:
            return True, None
        req = completion.get("require")
        if not req:
            return True, None
        snap = {"action": {"name": action_name, "args": {}}, "state": self.agent["state"]}
        if not eval_predicate(req, snap):
            return False, "completion_gate_failed"
        return True, None

    def apply_state_transition(self, transition: dict[str, Any] | None) -> None:
        if not transition:
            return
        next_state = dict(self.agent["state"])
        for k, v in (transition.get("set") or {}).items():
            next_state[k] = v
        for k in transition.get("remove") or []:
            next_state.pop(k, None)
        self.agent["state"] = next_state

    def invoke_native(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        if self.ri < len(self.recorded):
            entry = self.recorded[self.ri]
            expected_seq = self.ri + 1
            if (
                entry.get("call_seq") != expected_seq
                or entry.get("tool") != name
                or not deep_eq(entry.get("args") or {}, args)
            ):
                raise RuntimeError(
                    f"Recorded transcript mismatch: expected call_seq={expected_seq} tool={name}"
                )
            self.ri += 1
            return normalize_envelope(entry["result"])
        return normalize_envelope(self.tools[name](args, {"state": self.agent["state"]}))

    def apply_fallback_state(self) -> None:
        fb = fallback_state_of(self.agent)
        if fb:
            self.agent["state"] = {**self.agent["state"], **fb}
        self.emit({"stage": "record", "verdict": "safe_state", "reason": "safe_state_entered"})

    def compare_child_envelope(self, args: dict[str, Any]) -> tuple[bool, str, str | None]:
        spawn = self.agent.get("spawn") or {}
        if spawn.get("allow") is False:
            return False, "gate_denied", "spawn.allow is false"
        child_tools = args.get("tools") or []
        parent_tools = self.parent_tools()
        if any(t not in parent_tools for t in child_tools):
            return False, "gate_denied", "tool escalation"
        child_fs = args.get("filesystem") or {}
        parent_fs = (self.agent.get("permissions") or {}).get("filesystem") or {}
        if child_fs.get("write_scopes"):
            parents = parent_fs.get("write_scopes") or []
            if any(not scope_covered(s, parents) for s in child_fs["write_scopes"]):
                return False, "gate_denied", "write_scopes escalation"
        if child_fs.get("read_scopes") and parent_fs.get("read_scopes"):
            if any(not scope_covered(s, parent_fs["read_scopes"]) for s in child_fs["read_scopes"]):
                return False, "gate_denied", "read_scopes escalation"
        child_limits = args.get("limits") or {}
        limits = self.agent.get("limits") or {}
        max_steps = limits.get("max_steps", 1000)
        max_tools = limits.get("max_tool_calls", 1000)
        remaining_steps = max_steps - self.steps
        remaining_calls = max_tools - self.tool_calls
        if "max_steps" in child_limits and child_limits["max_steps"] > remaining_steps:
            return False, "gate_denied", "max_steps escalation"
        if "max_tool_calls" in child_limits and child_limits["max_tool_calls"] > remaining_calls:
            return False, "gate_denied", "max_tool_calls escalation"
        if args.get("spawn_nested") is True or (args.get("spawn") or {}).get("allow") is True:
            if spawn.get("allow_nested") is not True:
                return False, "gate_denied", "nested spawn denied"
        return True, "", None

    def run_observation(self, observer_id: str) -> tuple[bool, dict[str, Any] | None]:
        observer = self.tool_by_id(observer_id)
        if not observer or observer.get("read_only") is not True:
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
        allowed = (self.agent.get("permissions") or {}).get("tools")
        if allowed is not None and observer_id not in allowed:
            self.emit(
                {
                    "stage": "authorize",
                    "verdict": "deny",
                    "reason": "capability_missing",
                    "tool": observer_id,
                }
            )
            return False, None
        max_tools = (self.agent.get("limits") or {}).get("max_tool_calls", 1000)
        if self.tool_calls >= max_tools:
            self.emit(
                {
                    "stage": "authorize",
                    "verdict": "deny",
                    "reason": "limit_exceeded",
                    "tool": observer_id,
                }
            )
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
        ok, errs = validate_against_schema(observer.get("output"), envelope["output"])
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
            {
                "stage": "observe",
                "verdict": "allow",
                "tool": observer_id,
                "args": {},
                "result": envelope["output"],
            }
        )
        return True, envelope["output"]

    def run_one_verify(
        self, v: dict[str, Any], action: dict[str, Any], result: dict[str, Any]
    ) -> bool:
        if v["kind"] == "judge":
            raise RuntimeError("judge verify forbidden in Track A")
        if v["kind"] == "effect":
            ok, observation = self.run_observation(v["observe"])
            if not ok:
                return False
            snapshot = {
                "action": action,
                "state": self.agent["state"],
                "result": result,
                "observation": observation,
            }
            if not eval_predicate(v["require"], snapshot):
                verdict = v.get("otherwise", "safe_state")
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
            self.emit(
                {
                    "stage": "verify",
                    "verdict": "allow",
                    "tool": action["name"],
                    "observation": observation,
                }
            )
            return True
        reason = (
            "verify_evidence_failed" if v["kind"] == "evidence" else "verify_absence_failed"
        )
        snapshot = {"action": action, "state": self.agent["state"], "result": result}
        if not eval_predicate(v["require"], snapshot):
            verdict = v.get("otherwise", "safe_state")
            self.emit(
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
        self.emit(
            {
                "stage": "verify",
                "verdict": "allow",
                "tool": action["name"],
                "result": result,
            }
        )
        return True

    def run_verifies(
        self, tool: dict[str, Any], action: dict[str, Any], result: dict[str, Any]
    ) -> bool:
        verifies = tool.get("verify") or []
        if not verifies:
            self.emit({"stage": "verify", "verdict": "allow"})
            return True
        for v in verifies:
            if not self.run_one_verify(v, action, result):
                return False
        return True

    def enter_safe_flow(self, trigger_reason: str) -> None:
        self.run_recovery(trigger_reason)

    def run_recovery(self, trigger_reason: str) -> None:
        recovery = self.agent.get("recovery")
        if not recovery or self.recovering:
            self.apply_fallback_state()
            return
        if recovery.get("on") and recovery["on"] != trigger_reason:
            self.apply_fallback_state()
            return
        self.recovering = True
        action = {
            "name": recovery["execute"]["tool"],
            "args": recovery["execute"].get("args") or {},
        }
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
            self.emit({"stage": "record", "verdict": "deny", "reason": "terminal_failure"})
            self.apply_fallback_state()
            self.recovering = False
            return
        ok, errs = validate_against_schema(tool.get("input"), action["args"])
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
            self.emit({"stage": "record", "verdict": "deny", "reason": "terminal_failure"})
            self.apply_fallback_state()
            self.recovering = False
            return
        self.emit(
            {
                "stage": "validate",
                "verdict": "allow",
                "tool": action["name"],
                "args": action["args"],
            }
        )
        self.emit(
            {
                "stage": "authorize",
                "verdict": "allow",
                "tool": action["name"],
                "args": action["args"],
            }
        )
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
            self.emit({"stage": "record", "verdict": "deny", "reason": "terminal_failure"})
            self.apply_fallback_state()
            self.recovering = False
            return
        ok, errs = validate_against_schema(tool.get("output"), envelope["output"])
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
            self.emit({"stage": "record", "verdict": "deny", "reason": "terminal_failure"})
            self.apply_fallback_state()
            self.recovering = False
            return
        self.apply_state_transition(envelope.get("state_transition"))
        self.emit(
            {
                "stage": "execute",
                "verdict": "allow",
                "tool": action["name"],
                "args": action["args"],
                "result": envelope["output"],
            }
        )
        verified = self.run_one_verify(recovery["verify"], action, envelope["output"])
        if verified:
            self.emit({"stage": "record", "verdict": "allow", "reason": "recovery_succeeded"})
            self.apply_fallback_state()
        else:
            self.emit({"stage": "record", "verdict": "deny", "reason": "terminal_failure"})
            self.apply_fallback_state()
        self.recovering = False

    def run_loop(self, max_iterations: int = 32) -> list[dict[str, Any]]:
        for _ in range(max_iterations):
            if not self.check_limits():
                break
            self.steps += 1
            if self.pi >= len(self.proposals):
                self.emit({"stage": "propose", "verdict": "allow"})
                break
            proposal = self.proposals[self.pi]
            self.pi += 1
            if proposal.get("type") == "stop":
                self.emit({"stage": "propose", "verdict": "allow"})
                break
            action = {"name": proposal["name"], "args": proposal.get("args") or {}}
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
                break
            allowed = (self.agent.get("permissions") or {}).get("tools")
            if allowed and action["name"] not in allowed and action["name"] != "agent.spawn":
                self.emit(
                    {
                        "stage": "validate",
                        "verdict": "deny",
                        "reason": "capability_missing",
                        "tool": action["name"],
                        "args": action["args"],
                    }
                )
                break
            ok, errs = validate_against_schema(tool.get("input"), action["args"])
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
                break
            self.emit(
                {
                    "stage": "validate",
                    "verdict": "allow",
                    "tool": action["name"],
                    "args": action["args"],
                }
            )
            gok, verdict, reason = self.eval_gates(
                {"action": action, "state": self.agent["state"]}
            )
            if not gok:
                self.emit(
                    {
                        "stage": "authorize",
                        "verdict": verdict,
                        "reason": reason,
                        "tool": action["name"],
                        "args": action["args"],
                    }
                )
                if verdict == "safe_state":
                    self.enter_safe_flow("gate_denied")
                break
            if action["name"] == "agent.spawn":
                cok, creason, cerr = self.compare_child_envelope(action["args"])
                if not cok:
                    ev: dict[str, Any] = {
                        "stage": "authorize",
                        "verdict": "deny",
                        "reason": creason,
                        "tool": action["name"],
                        "args": action["args"],
                    }
                    if cerr:
                        ev["error"] = cerr
                    self.emit(ev)
                    break
            mok, mreason = self.check_mode(action["name"])
            if not mok:
                self.emit(
                    {
                        "stage": "authorize",
                        "verdict": "deny",
                        "reason": mreason,
                        "tool": action["name"],
                        "args": action["args"],
                    }
                )
                break
            sok, sreason = self.check_sequences(action)
            if not sok:
                self.emit(
                    {
                        "stage": "authorize",
                        "verdict": "deny",
                        "reason": sreason,
                        "tool": action["name"],
                        "args": action["args"],
                    }
                )
                break
            cok2, creason2 = self.check_completion(action["name"])
            if not cok2:
                self.emit(
                    {
                        "stage": "authorize",
                        "verdict": "deny",
                        "reason": creason2,
                        "tool": action["name"],
                        "args": action["args"],
                    }
                )
                break
            self.emit(
                {
                    "stage": "authorize",
                    "verdict": "allow",
                    "tool": action["name"],
                    "args": action["args"],
                }
            )
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
                break
            ok, errs = validate_against_schema(tool.get("output"), envelope["output"])
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
                break
            self.apply_state_transition(envelope.get("state_transition"))
            self.emit(
                {
                    "stage": "execute",
                    "verdict": "allow",
                    "tool": action["name"],
                    "args": action["args"],
                    "result": envelope["output"],
                }
            )
            if not self.run_verifies(tool, action, envelope["output"]):
                break
            self.apply_invalidate_after(action["name"])
        return self.events


def events_to_jsonl(events: list[dict[str, Any]]) -> str:
    return "".join(canonical_json(e) + "\n" for e in events)


def default_tools(agent: dict[str, Any]) -> dict[str, ToolHandler]:
    world = {
        "temperature_decidegrees": int(agent["state"].get("temperature_decidegrees", 250)),
        "fan_percent": int(agent["state"].get("fan_percent", 0)),
        "sensor_healthy": int(agent["state"].get("sensor_healthy", 1)),
        "files": {"src/app.ts": "export {}"},
        "write_scopes": ((agent.get("permissions") or {}).get("filesystem") or {}).get(
            "write_scopes", ["src/"]
        ),
        "last_exit_code": 1,
        "out_of_scope_writes": 0,
    }

    def temp_read(args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        return {"output": {"celsius_decidegrees": world["temperature_decidegrees"]}}

    def fan_read(args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        return {"output": {"percent": world["fan_percent"]}}

    def fan_set(args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        percent = int(args["percent"])
        world["fan_percent"] = percent
        return {
            "output": {"ok": 1, "percent": percent},
            "state_transition": {"set": {"fan_percent": percent}},
        }

    def wait(args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        return {"output": {"waited_ms": int(args.get("ms", 0))}}

    def fs_read(args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        path = str(args["path"])
        return {
            "output": {
                "path": path,
                "content": world["files"].get(path, ""),
                "found": 1 if path in world["files"] else 0,
            }
        }

    def fs_write(args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        path = str(args["path"])
        content = str(args.get("content", ""))
        allowed = any(
            path == s or path.startswith(s if s.endswith("/") else s + "/")
            for s in world["write_scopes"]
        )
        if not allowed:
            world["out_of_scope_writes"] += 1
            return {
                "output": {"ok": 0, "out_of_scope": 1, "path": path},
                "state_transition": {"set": {"out_of_scope_writes": world["out_of_scope_writes"]}},
            }
        world["files"][path] = content
        return {"output": {"ok": 1, "out_of_scope": 0, "path": path}}

    def shell(args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        cmd = str(args["cmd"])
        if cmd in ("test", "typecheck"):
            return {"output": {"exit_code": world["last_exit_code"], "cmd": cmd}}
        return {"output": {"exit_code": 1, "cmd": cmd, "error": "not allowlisted"}}

    def spawn(args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        return {"output": {"spawned": 1, "tools": args.get("tools") or []}}

    def mode_enter(args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        mode = str(args.get("mode", ""))
        return {"output": {"ok": 1, "mode": mode}, "state_transition": {"set": {"mode": mode}}}

    def task_complete(args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        return {"output": {"ok": 1}}

    def user_correct(args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        sett = args.get("set") or {}
        return {"output": {"ok": 1}, "state_transition": {"set": sett}}

    def kb_lookup(args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        q = str(args.get("query", "x"))[:24]
        return {
            "output": {"ok": 1, "article_id": f"kb-{q}"},
            "state_transition": {"set": {"kb_cited": 1}},
        }

    def answer_send(args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        return {"output": {"ok": 1}}

    def human_handoff(args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        return {
            "output": {"ok": 1},
            "state_transition": {"set": {"handoff": 1, "mode": "handoff"}},
        }

    def refund_request(args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        return {"output": {"ok": 1}}

    return {
        "sensor.temperature.read": temp_read,
        "sensor.fan.read_percent": fan_read,
        "actuator.fan.set": fan_set,
        "system.wait": wait,
        "fs.read": fs_read,
        "fs.write_scoped": fs_write,
        "shell.run_allowlisted": shell,
        "user.approve": lambda a, c: {"output": {"approved": 0}},
        "user.correct": user_correct,
        "mode.enter": mode_enter,
        "task.complete": task_complete,
        "kb.lookup": kb_lookup,
        "answer.send": answer_send,
        "human.handoff": human_handoff,
        "refund.request": refund_request,
        "agent.spawn": spawn,
    }


def replay_fixture(dir_path: Path) -> tuple[bool, str, str]:
    agent = json.loads((dir_path / "agent.json").read_text(encoding="utf-8"))
    if agent.get("safe_state") and not agent.get("fallback_state"):
        agent["fallback_state"] = agent["safe_state"]
    proposals = [
        json.loads(line)
        for line in (dir_path / "model.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    tools_path = dir_path / "tools.jsonl"
    recorded = None
    if tools_path.exists():
        recorded = [
            json.loads(line)
            for line in tools_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
    rt = FaustRuntime(agent, proposals, default_tools(agent), recorded)
    rt.run_loop()
    actual = events_to_jsonl(rt.events)
    expected = (dir_path / "expected.jsonl").read_text(encoding="utf-8").replace("\r\n", "\n")
    return actual == expected, actual, expected
