"""module.* host adapter (M17) — recorded + stdio, mirroring TS adapters/module.ts."""
import sys
import textwrap
from pathlib import Path

import pytest

from fausth.adapter_error import AdapterError
from fausth.module_adapter import create_module_handlers, live_module_session_count, parse_module_native
from fausth.registry import resolve_tools_from_deployment

AGENT = {"spec": "counterbalance-contract/v0.1", "name": "m", "state": {}, "tools": [{"id": "echo.ping"}]}


def test_parse_module_native():
    assert parse_module_native("module.echo.echo.ping") == ("echo", "echo.ping")
    assert parse_module_native("module..x") is None and parse_module_native("module.echo.") is None


def test_recorded_exact_match_only(tmp_path: Path):
    (tmp_path / "rec.jsonl").write_text(
        '{"tool":"echo.ping","args":{"message":"a"},"result":{"ok":1,"echo":"a"}}\r\n'
        '{"tool":"echo.ping","args":{"message":"b"},"result":{"output":{"ok":1,"echo":"b"}}}\n',
        encoding="utf-8",
    )
    dep = {"bindings": {"echo.ping": {"native": "module.echo.echo.ping"}}, "module": {"echo": {"transport": "recorded", "recorded": "rec.jsonl"}}}
    tools = resolve_tools_from_deployment(AGENT, dep, harness_dir=str(tmp_path))
    assert tools["echo.ping"]({"message": "b"}, {}) == {"output": {"ok": 1, "echo": "b"}}
    assert tools["echo.ping"]({"message": "a"}, {}) == {"output": {"ok": 1, "echo": "a"}}
    with pytest.raises(AdapterError) as e:
        tools["echo.ping"]({"message": "a"}, {})  # consumed; no tool-only fallback
    assert e.value.code == "recorded_response_missing"
    tools.close()


def test_recorded_path_must_stay_inside_harness(tmp_path: Path):
    dep = {"bindings": {"echo.ping": {"native": "module.echo.echo.ping"}}, "module": {"echo": {"transport": "recorded", "recorded": "../x.jsonl"}}}
    tools = resolve_tools_from_deployment(AGENT, dep, harness_dir=str(tmp_path))
    with pytest.raises(AdapterError):
        tools["echo.ping"]({}, {})


SERVER = textwrap.dedent(
    """
    import json, sys, time
    for line in sys.stdin:
        req = json.loads(line)
        args = req["args"]
        if args.get("mode") == "slow":
            time.sleep(2)
        if args.get("mode") == "error":
            print(json.dumps({"error": "boom"}), flush=True)
            continue
        if args.get("mode") == "die":
            sys.exit(3)
        print(json.dumps({"output": {"ok": 1, "echo": args.get("message", ""), "tool": req["tool"]}}), flush=True)
    """
)


def _stdio_dep(tmp_path: Path, timeout_ms: int = 5000) -> dict:
    (tmp_path / "server.py").write_text(SERVER, encoding="utf-8")
    return {
        "bindings": {"echo.ping": {"native": "module.echo.echo.ping"}},
        "module": {"echo": {"transport": "stdio", "command": sys.executable, "args": ["server.py"], "timeout_ms": timeout_ms}},
    }


def test_stdio_round_trip_error_and_cleanup(tmp_path: Path):
    before = live_module_session_count()
    tools = resolve_tools_from_deployment(AGENT, _stdio_dep(tmp_path), harness_dir=str(tmp_path))
    with tools:
        assert tools["echo.ping"]({"message": "hi"}, {}) == {"output": {"ok": 1, "echo": "hi", "tool": "echo.ping"}}
        with pytest.raises(AdapterError, match="module call failed: boom"):
            tools["echo.ping"]({"mode": "error"}, {})
        assert tools["echo.ping"]({"message": "again"}, {})["output"]["echo"] == "again"
        assert live_module_session_count() == before + 1
    assert live_module_session_count() == before


def test_stdio_timeout_tears_down_session(tmp_path: Path):
    tools = resolve_tools_from_deployment(AGENT, _stdio_dep(tmp_path, timeout_ms=300), harness_dir=str(tmp_path))
    with tools:
        with pytest.raises(AdapterError, match="module stdio timeout after 300ms"):
            tools["echo.ping"]({"mode": "slow"}, {})
        # a fresh session answers the next call; the late reply is never delivered to it
        assert tools["echo.ping"]({"message": "next"}, {})["output"]["echo"] == "next"


def test_stdio_process_exit_is_reported(tmp_path: Path):
    tools = resolve_tools_from_deployment(AGENT, _stdio_dep(tmp_path), harness_dir=str(tmp_path))
    with tools:
        with pytest.raises(AdapterError, match=r"process exited \(code=3, signal=null\)"):
            tools["echo.ping"]({"mode": "die"}, {})


def test_secret_like_env_names_rejected(tmp_path: Path):
    dep = _stdio_dep(tmp_path)
    dep["module"]["echo"]["env"] = {"OPENAI_API_KEY": "x"}
    with pytest.raises(AdapterError):
        create_module_handlers(dep, harness_dir=str(tmp_path))
