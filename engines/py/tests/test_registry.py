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
