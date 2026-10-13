from fausth.registry import resolve_tools_from_deployment


def test_resolve_known_natives():
    agent = {
        "state": {},
        "tools": [{"id": "fs.read"}, {"id": "task.complete"}],
    }
    deployment = {
        "bindings": {
            "fs.read": {"native": "sim.fs_read"},
            "task.complete": {"native": "sim.task_complete"},
        }
    }
    tools = resolve_tools_from_deployment(agent, deployment)
    assert "fs.read" in tools
    assert "task.complete" in tools
    assert len(tools) == 2


def test_binding_missing():
    agent = {"state": {}, "tools": [{"id": "fs.read"}, {"id": "task.complete"}]}
    deployment = {"bindings": {"fs.read": {"native": "stub.fs_read"}}}
    try:
        resolve_tools_from_deployment(agent, deployment)
        assert False, "expected AdapterError"
    except Exception as e:
        assert "binding_missing" in str(e) or getattr(e, "code", None) == "binding_missing"


def test_resolve_returns_toolset_that_runs_cleanup(monkeypatch):
    import fausth.mcp as mcp
    from fausth.registry import ToolSet

    calls = []

    def fake_create(deployment, *, harness_dir, mcp_tool_map):
        return {"echo.ping": lambda a, c: {"output": {"ok": 1}}}, {"mcp.srv.echo.ping": "echo.ping"}, lambda: calls.append("closed")

    monkeypatch.setattr(mcp, "create_mcp_handlers", fake_create)
    agent = {"state": {}, "tools": [{"id": "echo.ping"}]}
    deployment = {"bindings": {"echo.ping": {"native": "mcp.srv.echo.ping"}}}
    tools = resolve_tools_from_deployment(agent, deployment, harness_dir=".")
    assert isinstance(tools, ToolSet) and "echo.ping" in tools
    with tools:
        pass
    assert calls == ["closed"]
    tools.close()
    assert calls == ["closed"]  # idempotent


def test_cleanup_runs_when_binding_resolution_fails(monkeypatch):
    import fausth.mcp as mcp

    calls = []
    monkeypatch.setattr(
        mcp,
        "create_mcp_handlers",
        lambda deployment, **kw: ({}, {}, lambda: calls.append("closed")),
    )
    agent = {"state": {}, "tools": [{"id": "fs.read"}]}
    deployment = {"bindings": {"other": {"native": "mcp.srv.x"}}}
    try:
        resolve_tools_from_deployment(agent, deployment, harness_dir=".")
        assert False, "expected AdapterError"
    except Exception as e:
        assert getattr(e, "code", None) == "binding_missing"
    assert calls == ["closed"]


def test_local_bindings_are_ts_only():
    agent = {"state": {}, "tools": [{"id": "fs.read"}]}
    deployment = {"bindings": {"fs.read": {"native": "local.fs_read"}}}
    try:
        resolve_tools_from_deployment(agent, deployment)
        assert False, "expected AdapterError"
    except Exception as e:
        assert getattr(e, "code", None) == "adapter_unresolved"


def test_native_table_matches_ts():
    import re
    from pathlib import Path

    from fausth.registry import NATIVE_TO_TOOL

    src = (Path(__file__).resolve().parents[3] / "engines" / "ts" / "src" / "adapters" / "registry.ts").read_text(encoding="utf-8")
    body = src.split("export const NATIVE_TO_TOOL", 1)[1].split("};", 1)[0]
    ts_table = dict(re.findall(r'"([^"]+)":\s*"([^"]+)"', body))
    assert NATIVE_TO_TOOL == ts_table
