from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any, Callable

from .canonical import canonical_json, state_hash
from .predicates import eval_predicate

ToolHandler = Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]]


class FaustRuntime:
    def __init__(
        self,
        agent: dict[str, Any],
        proposals: list[dict[str, Any]],
        tools: dict[str, ToolHandler],
        recorded_tool_results: list[dict[str, Any]] | None = None,
    ) -> None:
        self.agent = copy.deepcopy(agent)
        self.proposals = proposals
        self.pi = 0
        self.tools = tools
        self.recorded = recorded_tool_results or []
        self.ri = 0
        self.events: list[dict[str, Any]] = []
        self.seq = 0
        self.steps = 0
        self.tool_calls = 0

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

    def run_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        if self.ri < len(self.recorded):
            r = self.recorded[self.ri]
            self.ri += 1
            return r
        return self.tools[name](args, {"state": self.agent["state"]})

    def apply_safe_state(self) -> None:
        if self.agent.get("safe_state"):
            self.agent["state"] = {**self.agent["state"], **self.agent["safe_state"]}
        self.emit({"stage": "record", "verdict": "safe_state", "reason": "safe_state_entered"})

    def run_verifies(self, tool: dict[str, Any], action: dict[str, Any], result: dict[str, Any]) -> bool:
        verifies = tool.get("verify") or []
        if not verifies:
            self.emit({"stage": "verify", "verdict": "allow"})
            return True
        for v in verifies:
            if v["kind"] == "judge":
                raise RuntimeError("judge verify forbidden in Track A")
            if v["kind"] == "effect":
                observation = self.run_tool(v["observe"], {})
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
                    if verdict == "safe_state":
                        self.apply_safe_state()
                    return False
                self.emit(
                    {
                        "stage": "verify",
                        "verdict": "allow",
                        "tool": action["name"],
                        "observation": observation,
                    }
                )
                continue
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
                if verdict == "safe_state":
                    self.apply_safe_state()
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
            self.emit(
                {
                    "stage": "validate",
                    "verdict": "allow",
                    "tool": action["name"],
                    "args": action["args"],
                }
            )
            ok, verdict, reason = self.eval_gates({"action": action, "state": self.agent["state"]})
            if not ok:
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
                    self.apply_safe_state()
                break
            if action["name"] == "agent.spawn":
                child_tools = action["args"].get("tools") or []
                parent_tools = allowed or [t["id"] for t in self.agent.get("tools", [])]
                if any(t not in parent_tools for t in child_tools):
                    self.emit(
                        {
                            "stage": "authorize",
                            "verdict": "deny",
                            "reason": "gate_denied",
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
            result = self.run_tool(action["name"], action["args"])
            if "_state_patch" in result:
                patch = result["_state_patch"]
                self.agent["state"] = {**self.agent["state"], **patch}
                result = {k: v for k, v in result.items() if k != "_state_patch"}
            self.emit(
                {
                    "stage": "execute",
                    "verdict": "allow",
                    "tool": action["name"],
                    "args": action["args"],
                    "result": result,
                }
            )
            if not self.run_verifies(tool, action, result):
                break
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
        return {"celsius_decidegrees": world["temperature_decidegrees"]}

    def fan_read(args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        return {"percent": world["fan_percent"]}

    def fan_set(args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        percent = int(args["percent"])
        world["fan_percent"] = percent
        return {"ok": 1, "percent": percent, "_state_patch": {"fan_percent": percent}}

    def wait(args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        return {"waited_ms": int(args.get("ms", 0))}

    def fs_read(args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        path = str(args["path"])
        return {
            "path": path,
            "content": world["files"].get(path, ""),
            "found": 1 if path in world["files"] else 0,
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
            return {"ok": 0, "out_of_scope": 1, "path": path}
        world["files"][path] = content
        return {"ok": 1, "out_of_scope": 0, "path": path}

    def shell(args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        cmd = str(args["cmd"])
        if cmd in ("test", "typecheck"):
            return {"exit_code": world["last_exit_code"], "cmd": cmd}
        return {"exit_code": 1, "cmd": cmd, "error": "not allowlisted"}

    def spawn(args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        return {"spawned": 1, "tools": args.get("tools") or []}

    return {
        "sensor.temperature.read": temp_read,
        "sensor.fan.read_percent": fan_read,
        "actuator.fan.set": fan_set,
        "system.wait": wait,
        "fs.read": fs_read,
        "fs.write_scoped": fs_write,
        "shell.run_allowlisted": shell,
        "user.approve": lambda a, c: {"approved": 0},
        "agent.spawn": spawn,
    }


def replay_fixture(dir_path: Path) -> tuple[bool, str, str]:
    agent = json.loads((dir_path / "agent.json").read_text(encoding="utf-8"))
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
