"""Resolve deployment.bindings → tool handlers (mirrors TS adapters/registry)."""
from __future__ import annotations

from typing import Any

import yaml

from .adapter_error import AdapterError
from .runtime import ToolHandler, default_tools

__all__ = ["AdapterError", "NATIVE_TO_TOOL", "load_yaml", "load_agent_dir", "resolve_tools_from_deployment"]

NATIVE_TO_TOOL: dict[str, str] = {
    "stub.fs_read": "fs.read",
    "sim.fs_read": "fs.read",
    "fs.read": "fs.read",
    "stub.fs_list": "fs.list",
    "sim.fs_list": "fs.list",
    "fs.list": "fs.list",
    "stub.fs_write": "fs.write_scoped",
    "sim.fs_write": "fs.write_scoped",
    "fs.write_scoped": "fs.write_scoped",
    "stub.shell": "shell.run_allowlisted",
    "sim.shell": "shell.run_allowlisted",
    "shell.run_allowlisted": "shell.run_allowlisted",
    "local.tau_invoke": "tau.invoke",
    "tau.invoke": "tau.invoke",
    "local.todo_complete": "todo.complete",
    "todo.complete": "todo.complete",
    "stub.approve": "user.approve",
    "sim.approve": "user.approve",
    "user.approve": "user.approve",
    "stub.ask": "user.ask",
    "user.ask": "user.ask",
    "stub.user_correct": "user.correct",
    "sim.user_correct": "user.correct",
  "user.correct": "user.correct",
    "stub.task_complete": "task.complete",
    "sim.task_complete": "task.complete",
    "task.complete": "task.complete",
    "stub.phase_yield": "phase.yield",
    "sim.phase_yield": "phase.yield",
    "phase.yield": "phase.yield",
    "stub.kb_lookup": "kb.lookup",
    "sim.kb_lookup": "kb.lookup",
    "kb.lookup": "kb.lookup",
    "stub.answer_send": "answer.send",
    "sim.answer_send": "answer.send",
    "answer.send": "answer.send",
    "stub.human_handoff": "human.handoff",
    "sim.human_handoff": "human.handoff",
    "human.handoff": "human.handoff",
    "stub.refund_request": "refund.request",
    "refund.request": "refund.request",
    "stub.spawn": "agent.spawn",
    "agent.spawn": "agent.spawn",
    "stub.harness_patch": "harness.propose_skills_patch",
    "sim.harness_patch": "harness.propose_skills_patch",
    "harness.propose_skills_patch": "harness.propose_skills_patch",
    "stub.harness_decline": "harness.decline_skills_patch",
    "sim.harness_decline": "harness.decline_skills_patch",
    "harness.decline_skills_patch": "harness.decline_skills_patch",
    "stub.harness_reflect": "harness.reflect_skills",
    "sim.harness_reflect": "harness.reflect_skills",
    "harness.reflect_skills": "harness.reflect_skills",
    "stub.temperature": "sensor.temperature.read",
    "sensor.temperature.read": "sensor.temperature.read",
    "stub.fan_read": "sensor.fan.read_percent",
    "sensor.fan.read_percent": "sensor.fan.read_percent",
    "stub.fan_set": "actuator.fan.set",
    "actuator.fan.set": "actuator.fan.set",
    "stub.wait": "system.wait",
    "system.wait": "system.wait",
}


def load_yaml(path: str) -> Any:
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def agent_yaml_to_ir(raw: Any) -> dict[str, Any]:
    """Mirror TS agentYamlToIr — keep only known AgentIR fields."""
    a = raw if isinstance(raw, dict) else {}
    ir: dict[str, Any] = {
        "spec": str(a.get("spec") or "counterbalance-contract/v0.1"),
        "name": str(a.get("name") or "unnamed"),
        "state": dict(a.get("state") or {}),
        "tools": list(a.get("tools") or []),
    }
    for key in (
        "gates",
        "limits",
        "fallback_state",
        "recovery",
        "permissions",
        "spawn",
        "counterbalance",
        "mutable",
        "instinct_text",
        "overlays",
    ):
        if key in a and a[key] is not None:
            ir[key] = a[key]
    if a.get("safe_state"):
        ir["safe_state"] = a["safe_state"]
        if "fallback_state" not in ir:
            ir["fallback_state"] = a["safe_state"]
    return ir


def load_agent_dir(dir_path: str) -> dict[str, Any]:
    from pathlib import Path

    d = Path(dir_path)
    yml = d / "agent.yml"
    js = d / "agent.json"
    if yml.exists():
        agent = agent_yaml_to_ir(load_yaml(str(yml)))
    elif js.exists():
        import json

        agent = json.loads(js.read_text(encoding="utf-8"))
        if agent.get("safe_state") and not agent.get("fallback_state"):
            agent["fallback_state"] = agent["safe_state"]
    else:
        raise FileNotFoundError(f"No agent.yml or agent.json in {dir_path}")
    return agent


def resolve_tools_from_deployment(
    agent: dict[str, Any],
    deployment: dict[str, Any],
    *,
    test_exit: int | None = None,
    harness_dir: str | None = None,
    resolved: dict[str, Any] | None = None,
) -> dict[str, ToolHandler]:
    from .mcp import create_mcp_handlers, deployment_uses_mcp, parse_mcp_native, mcp_tool_map_from_resolved

    pool = default_tools(agent)
    if test_exit is not None:
        def shell(args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
            cmd = str(args["cmd"])
            if cmd in ("test", "typecheck"):
                return {"output": {"exit_code": test_exit, "cmd": cmd}}
            return {"output": {"exit_code": 1, "cmd": cmd, "error": "not allowlisted: only 'test' and 'typecheck' are available; use fs.read/fs.list to explore"}}

        pool["shell.run_allowlisted"] = shell

    mcp_native_to_tool: dict[str, str] = {}
    if deployment_uses_mcp(deployment):
        if not harness_dir:
            raise AdapterError(
                "adapter_unresolved",
                "adapter failure: mcp.* bindings require harness directory context",
            )
        handlers, mcp_native_to_tool, _cleanup = create_mcp_handlers(
            deployment,
            harness_dir=harness_dir,
            mcp_tool_map=mcp_tool_map_from_resolved(resolved),
        )
        pool = {**pool, **handlers}

    bindings = deployment.get("bindings") or {}
    out: dict[str, ToolHandler] = {}
    for tool in agent.get("tools") or []:
        tid = tool["id"]
        binding = bindings.get(tid)
        if not binding or not isinstance(binding.get("native"), str) or not binding["native"]:
            raise AdapterError(
                "binding_missing",
                f"adapter failure: no deployment binding for tool '{tid}' (binding_missing)",
            )
        native = binding["native"]
        mapped = NATIVE_TO_TOOL.get(native) or mcp_native_to_tool.get(native)
        if mapped is None and native.startswith("mcp."):
            parsed = parse_mcp_native(native)
            if parsed and parsed[1] == tid:
                mapped = tid
        if not mapped:
            raise AdapterError(
                "adapter_unresolved",
                f"adapter failure: unknown native '{native}' for tool '{tid}' (adapter_unresolved)",
            )
        if mapped != tid:
            raise AdapterError(
                "adapter_unresolved",
                f"adapter failure: native '{native}' maps to '{mapped}', not '{tid}' (adapter_unresolved)",
            )
        handler = pool.get(tid)
        if handler is None:
            raise AdapterError(
                "adapter_unresolved",
                f"adapter failure: no host handler for tool '{tid}' (adapter_unresolved)",
            )
        out[tid] = handler
    return out
