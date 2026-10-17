from pathlib import Path

import pytest

from fausth import chess_tools
from fausth.engine import run
from fausth.harness import read_harness
from fausth.engine import InfraFailure
from fausth.host import CliHost, DeploymentError, ToolError, load_deployment

ROOT = Path(__file__).resolve().parents[3]
CHESS = read_harness((ROOT / "examples" / "chess" / "harness.yaml").read_text("utf-8"))


MODEL = "model: { base_url: 'http://127.0.0.1:9', api_key_env: TEST_KEY, model: m }\n"


def test_a_deployment_that_leaves_an_id_unbound_is_rejected(tmp_path):
    (tmp_path / "d.yaml").write_text(MODEL + "bindings:\n  board_observe: { script: 'fausth.chess_tools:board_observe' }\n")
    with pytest.raises(DeploymentError, match="unbound: board_legal_moves, board_move"):
        load_deployment(tmp_path / "d.yaml", CHESS)


def test_a_deployment_needs_a_model(tmp_path):
    (tmp_path / "d.yaml").write_text("bindings: {}\n")
    with pytest.raises(DeploymentError, match="model needs"):
        load_deployment(tmp_path / "d.yaml", {"spec": "x", "name": "n", "prompt": ""})


def test_recorded_and_model_bindings(tmp_path, monkeypatch):
    monkeypatch.setenv("TEST_KEY", "x")
    (tmp_path / "answers.jsonl").write_text('{"id": "judge", "ok": true, "result": {"decision": "allow"}}\n{"ok": false, "error": "no"}\n')
    (tmp_path / "d.yaml").write_text(MODEL + "bindings:\n  judge: { recorded: answers.jsonl }\n  critic: { model: { prompt: Judge. } }\n")
    harness = {"spec": "x", "name": "n", "prompt": "", "handlers": {"judge": {}, "critic": {}}}
    host = CliHost(load_deployment(tmp_path / "d.yaml", harness), tmp_path, iter([]), verbose=False)
    assert host.call("judge", {}) == {"ok": True, "result": {"decision": "allow"}}
    assert host.call("judge", {}) == {"ok": False, "error": "no"}
    with pytest.raises(InfraFailure):
        host.call("judge", {})
    seen = []
    from fausth import host as host_module
    monkeypatch.setattr(host_module.ChatModel, "__call__", lambda self, request: seen.append(request) or {"text": '```json\n{"decision": "allow"}\n```'})
    critic = host._model("critic", {"prompt": "Judge."}, tmp_path)
    assert critic({"event": "stop"}) == {"ok": True, "result": {"decision": "allow"}}
    assert seen[0]["messages"][0]["text"] == '{"event":"stop"}'


def test_timeout_ms_ends_the_run_with_host_end(monkeypatch):
    monkeypatch.setenv("TEST_KEY", "x")
    deployment = load_deployment(ROOT / "examples" / "chess" / "deployment.kit.yaml", CHESS)
    deployment["model"]["api_key_env"] = "TEST_KEY"
    host = CliHost(deployment, ROOT / "examples" / "chess", iter(["Play."]), timeout_ms=0, verbose=False)
    log = run(CHESS, host)
    assert log.entries[-1]["reason"] == "host_end"


def test_chess_tools_report_failures_the_model_should_see():
    state = {}
    h = chess_tools.board_observe({}, state)["position_hash"]
    with pytest.raises(ToolError, match="stale"):
        chess_tools.board_move({"move": "e2e4", "position_hash": "0", "reason": "r"}, state)
    with pytest.raises(ToolError, match="illegal"):
        chess_tools.board_move({"move": "e2e5", "position_hash": h, "reason": "r"}, state)
    with pytest.raises(ToolError, match="not a UCI move"):
        chess_tools.board_move({"move": "e4", "position_hash": h, "reason": "r"}, state)
    assert chess_tools.board_move({"move": "e2e4", "position_hash": h, "reason": "r"}, state)["san"] == "e4"
    assert chess_tools.board_observe({}, state)["side_to_move"] == "black"


def test_the_chess_harness_runs_on_the_cli_host_with_a_scripted_model(monkeypatch):
    monkeypatch.setenv("TEST_KEY", "x")
    deployment = load_deployment(ROOT / "examples" / "chess" / "deployment.kit.yaml", CHESS)
    deployment["model"]["api_key_env"] = "TEST_KEY"
    host = CliHost(deployment, ROOT / "examples" / "chess", iter(["Play."]), verbose=False)
    replies = iter([
        {"tool_calls": [{"tool": "board_observe", "args": {}}]},
        {"tool_calls": [{"tool": "board_legal_moves", "args": {}}]},
        None,  # filled in below with the position hash the tools report
        {"text": "Played d4."},
    ])

    def scripted(request):
        reply = next(replies)
        if reply is None:
            h = chess_tools.position_hash(host.state["board"])
            reply = {"tool_calls": [{"tool": "board_move", "args": {"move": "d2d4", "position_hash": h, "reason": "center"}}]}
        return reply

    host.transport = scripted
    log = run(CHESS, host)
    assert log.entries[-1] == {"seq": len(log.entries), "type": "run_end", "reason": "stop"}
    assert host.state["board"].peek().uci() == "d2d4"
