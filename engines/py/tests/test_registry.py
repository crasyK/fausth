import pytest

from fausth.registry import AdapterError, resolve_tools_from_deployment


def test_resolve_ok():
    agent = {
        "state": {},
        "tools": [{"id": "fs.read"}, {"id": "mode.enter"}],
        "permissions": {"filesystem": {"write_scopes": ["src/"]}},
    }
    dep = {
        "bindings": {
            "fs.read": {"native": "sim.fs_read"},
            "mode.enter": {"native": "sim.mode_enter"},
        }
    }
    tools = resolve_tools_from_deployment(agent, dep)
    assert "fs.read" in tools
    assert "mode.enter" in tools


def test_binding_missing():
    agent = {"state": {}, "tools": [{"id": "fs.read"}, {"id": "mode.enter"}]}
    dep = {"bindings": {"fs.read": {"native": "stub.fs_read"}}}
    with pytest.raises(AdapterError) as ei:
        resolve_tools_from_deployment(agent, dep)
    assert ei.value.code == "binding_missing"


def test_adapter_unresolved():
    agent = {"state": {}, "tools": [{"id": "fs.read"}]}
    dep = {"bindings": {"fs.read": {"native": "no.such"}}}
    with pytest.raises(AdapterError) as ei:
        resolve_tools_from_deployment(agent, dep)
    assert ei.value.code == "adapter_unresolved"
