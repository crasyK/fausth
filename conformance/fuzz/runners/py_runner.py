"""Cross-engine parity runner (Python side) — twin of ``ts-runner.ts``.

Run with the repository's engine on the path::

    PYTHONPATH=engines/py .venv/bin/python conformance/fuzz/runners/py_runner.py < requests.jsonl
"""
from __future__ import annotations

import json
import sys
from typing import Any


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    from fausth.canonical import canonical_json, js_json_stringify, json_loads
    from fausth.registry import NATIVE_TO_TOOL, agent_yaml_to_ir, load_yaml_text, resolve_tools_from_deployment
    from fausth.runtime import FaustRuntime, default_tools, events_to_jsonl, normalize_envelope
    from fausth.validate import validate_agent

    kind = req.get("kind")

    def simulation_tools(agent: dict[str, Any]) -> dict[str, Any]:
        bindings = {
            t["id"]: {"native": t["id"]}
            for t in agent.get("tools") or []
            if isinstance(t, dict) and isinstance(t.get("id"), str) and NATIVE_TO_TOOL.get(t["id"]) == t["id"]
        }
        return resolve_tools_from_deployment(agent, {"model": {"transport": "recorded"}, "bindings": bindings})

    if kind == "canonical":
        return {"out": canonical_json(json_loads(req["json_text"]))}
    if kind == "yaml":
        return {"out": canonical_json(load_yaml_text(req["text"]))}
    if kind == "agent_yaml":
        return {"out": canonical_json(agent_yaml_to_ir(load_yaml_text(req["text"])))}
    if kind == "schema":
        from fausth.schema_validate import validate_against_schema

        ok, _ = validate_against_schema(req.get("schema"), req.get("data"))
        return {"out": "valid" if ok else "invalid"}
    if kind == "validate":
        ok, errors, warnings = validate_agent(req["agent"])
        return {"out": canonical_json({"ok": ok, "warnings": warnings})}
    if kind == "world":
        agent = req["agent"]
        tools = simulation_tools(agent) if req.get("world") == "simulation" else default_tools(agent)
        outs: list[Any] = []
        for call in req.get("calls") or []:
            h = tools.get(call["tool"])
            if h is None:
                outs.append({"missing": call["tool"]})
                continue
            try:
                env = h(call.get("args"), {"state": agent.get("state")})
                outs.append({"envelope": json_loads(js_json_stringify(env))})
            except Exception as e:  # noqa: BLE001 - parity runner reports any handler error
                outs.append({"error": str(e)})
        return {"out": canonical_json(outs)}
    if kind == "run":
        agent = req["agent"]
        tools = simulation_tools(agent) if req.get("world") == "simulation" else default_tools(agent)
        rt = FaustRuntime(
            agent,
            list(req.get("model_lines") or []),
            tools,
            req.get("tools") or None,
            parse_proposals=req.get("raw_proposals") is not True,
        )
        max_steps = req.get("max_steps")
        rt.run_loop(max_steps if isinstance(max_steps, int) else 32)
        return {"out": events_to_jsonl(rt.events)}
    raise ValueError(f"unknown request kind {kind!r}")


def main() -> int:
    from fausth.canonical import json_loads

    raw = sys.stdin.buffer.read().decode("utf-8")
    out_lines: list[str] = []
    for line in raw.split("\n"):
        if not line.strip():
            continue
        req = json_loads(line)
        try:
            res = {"id": req.get("id"), "ok": True, **_handle(req)}
        except Exception as e:  # noqa: BLE001
            res = {"id": req.get("id"), "ok": False, "error": str(e)}
        out_lines.append(json.dumps(res, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n".join(out_lines) + ("\n" if out_lines else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
