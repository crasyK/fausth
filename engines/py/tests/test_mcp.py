"""EDGE-9/10, PY-3, PY-19: fausth-py MCP host sessions."""
from __future__ import annotations

import json
import os
import sys
import textwrap
import time
from pathlib import Path

import pytest

from fausth.adapter_error import AdapterError
from fausth.mcp import (
    build_child_env,
    close_all_host_sessions,
    create_mcp_handlers,
    live_host_session_count,
)
from fausth.provenance import register_bundle_dir, unregister_bundle_dir

SERVER = textwrap.dedent(
    """
    import json, os, sys, time
    for line in sys.stdin:
        msg = json.loads(line)
        mid = msg.get("id")
        if msg.get("method") == "initialize":
            print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"capabilities": {}}}), flush=True)
            continue
        if msg.get("method") != "tools/call":
            continue
        args = msg["params"]["arguments"]
        if args.get("mode") == "env":
            out = {"keys": sorted(os.environ)}
        elif args.get("mode") == "noisy":
            sys.stderr.write("x" * (1 << 20)); sys.stderr.flush()
            out = {"ok": 1}
        elif args.get("mode") == "slow":
            time.sleep(0.6)
            out = {"late": 1}
        else:
            out = {"echo": args.get("message")}
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"structuredContent": out}}), flush=True)
    """
)


def _deployment(tmp: Path, **server_extra) -> dict:
    (tmp / "server.py").write_text(SERVER, encoding="utf-8")
    server = {"transport": "stdio", "command": sys.executable, "args": [str(tmp / "server.py")], "timeout_ms": 3000}
    server.update(server_extra)
    return {"model": {"transport": "recorded"}, "bindings": {"echo.call": {"native": "mcp.srv.echo.call"}}, "mcp": {"srv": server}}


@pytest.fixture(autouse=True)
def _no_operator_allow(monkeypatch):
    monkeypatch.delenv("FAUSTH_ALLOW_COMMANDS", raising=False)
    monkeypatch.delenv("FAUSTH_ALLOW_UNTRUSTED_BUNDLE_COMMANDS", raising=False)
    yield
    close_all_host_sessions()


def test_child_env_is_an_allowlist(tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_PROVIDER_API_KEY", "sk-fake-provider-key-0123456789abcdef")
    monkeypatch.setenv("GH_TOKEN", "fake-gh-token")
    monkeypatch.setenv("FAUSTH_TEST_PASSTHROUGH", "visible")
    handlers, _, cleanup = create_mcp_handlers(
        _deployment(tmp_path, env_passthrough=["FAUSTH_TEST_PASSTHROUGH"]), harness_dir=tmp_path
    )
    try:
        keys = handlers["echo.call"]({"mode": "env"}, {})["output"]["keys"]
    finally:
        cleanup()
    assert "FAKE_PROVIDER_API_KEY" not in keys
    assert "GH_TOKEN" not in keys
    assert "FAUSTH_TEST_PASSTHROUGH" in keys
    with pytest.raises(AdapterError, match="secret-like"):
        create_mcp_handlers(_deployment(tmp_path, env_passthrough=["OPENROUTER_API_KEY"]), harness_dir=tmp_path)
    with pytest.raises(AdapterError, match="secret-like"):
        build_child_env(set_env={"MY_TOKEN": "x"})


def test_stderr_flood_is_drained_and_cleanup_kills(tmp_path):
    before = live_host_session_count()
    handlers, _, cleanup = create_mcp_handlers(_deployment(tmp_path), harness_dir=tmp_path)
    assert handlers["echo.call"]({"mode": "noisy"}, {})["output"] == {"ok": 1}
    assert live_host_session_count() == before + 1
    cleanup()
    assert live_host_session_count() == before


def test_spawn_failure_is_an_adapter_error(tmp_path):
    dep = _deployment(tmp_path)
    dep["mcp"]["srv"]["command"] = str(tmp_path / "does-not-exist")
    handlers, _, cleanup = create_mcp_handlers(dep, harness_dir=tmp_path)
    with pytest.raises(AdapterError) as ei:
        handlers["echo.call"]({"message": "x"}, {})
    assert ei.value.code == "host_session_failed"
    cleanup()


def test_late_reply_after_timeout_is_not_reused(tmp_path):
    handlers, _, cleanup = create_mcp_handlers(_deployment(tmp_path, timeout_ms=200), harness_dir=tmp_path)
    try:
        with pytest.raises(AdapterError, match="timeout"):
            handlers["echo.call"]({"mode": "slow"}, {})
        time.sleep(0.8)
        assert handlers["echo.call"]({"message": "fresh"}, {})["output"] == {"echo": "fresh"}
    finally:
        cleanup()


def test_recorded_exact_args_and_containment(tmp_path):
    (tmp_path / "rec.jsonl").write_text(
        json.dumps({"tool": "get_forecast", "args": {"city": "Berlin"}, "result": {"summary": "sunny"}}) + "\n",
        encoding="utf-8",
    )
    dep = {
        "model": {"transport": "recorded"},
        "bindings": {"get_forecast": {"native": "mcp.w.get_forecast"}},
        "mcp": {"w": {"transport": "recorded", "recorded": "rec.jsonl"}},
    }
    handlers, _, _ = create_mcp_handlers(dep, harness_dir=tmp_path)
    with pytest.raises(AdapterError) as ei:
        handlers["get_forecast"]({"city": "Paris"}, {})
    assert ei.value.code == "recorded_response_missing"
    handlers, _, _ = create_mcp_handlers(dep, harness_dir=tmp_path)
    assert handlers["get_forecast"]({"city": "Berlin"}, {})["output"] == {"summary": "sunny"}

    outside = tmp_path.parent / f"{tmp_path.name}-outside"
    outside.mkdir()
    (outside / "rec.jsonl").write_text("{}\n", encoding="utf-8")
    (tmp_path / "sub").mkdir()
    os.symlink(outside / "rec.jsonl", tmp_path / "sub" / "link.jsonl")
    for recorded in ("../rec.jsonl", "/etc/passwd", "sub/link.jsonl"):
        bad = json.loads(json.dumps(dep))
        bad["mcp"]["w"]["recorded"] = recorded
        handlers, _, _ = create_mcp_handlers(bad, harness_dir=tmp_path)
        with pytest.raises(AdapterError):
            handlers["get_forecast"]({"city": "Berlin"}, {})


@pytest.mark.parametrize("trust", ["unsigned", "signed-untrusted", "signed-trusted"])
def test_bundle_deployment_needs_operator_allow_and_trust(tmp_path, trust):
    dep = _deployment(tmp_path)
    register_bundle_dir(tmp_path, {"bundle": "/x/evil.fausth.json", "format": "fausth-harness-bundle/v0.3", "trust": trust})
    try:
        handlers, _, cleanup = create_mcp_handlers(dep, harness_dir=tmp_path)
        with pytest.raises(AdapterError) as ei:
            handlers["echo.call"]({"message": "x"}, {})
        assert ei.value.code == "spawn_not_allowed"
        cleanup()

        handlers, _, cleanup = create_mcp_handlers(
            dep, harness_dir=tmp_path, spawn_policy={"allow_commands": [sys.executable]}
        )
        if trust == "signed-trusted":
            assert handlers["echo.call"]({"message": "ok"}, {})["output"] == {"echo": "ok"}
        else:
            with pytest.raises(AdapterError) as ei:
                handlers["echo.call"]({"message": "x"}, {})
            assert ei.value.code == "spawn_not_allowed"
        cleanup()

        handlers, _, cleanup = create_mcp_handlers(
            dep,
            harness_dir=tmp_path,
            spawn_policy={"allow_commands": [sys.executable], "allow_untrusted_bundles": True},
        )
        assert handlers["echo.call"]({"message": "ok"}, {})["output"] == {"echo": "ok"}
        cleanup()

        # An operator-provided deployment file outside the bundle dir is not restricted.
        handlers, _, cleanup = create_mcp_handlers(
            dep, harness_dir=tmp_path, deployment_path=tmp_path.parent / "operator-deployment.yml"
        )
        assert handlers["echo.call"]({"message": "op"}, {})["output"] == {"echo": "op"}
        cleanup()
    finally:
        unregister_bundle_dir(tmp_path)
