"""Registry wiring of the User cell (D14): user: bindings, removed self-answering natives,
unbound channel → capability_missing, simulator source over an OpenAI-compatible API."""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from fausth.adapter_error import AdapterError
from fausth.registry import resolve_tools_from_deployment
from fausth.runtime import FaustRuntime, events_to_jsonl

OBJ = {"type": "object", "additionalProperties": True}
ASK = {
    "id": "user.ask",
    "channel": "user",
    "input": OBJ,
    "output": {"type": "object", "required": ["answer"], "properties": {"answer": {"type": "string"}}},
}


def agent(*tools, **extra):
    a = {"spec": "counterbalance-contract/v0.1", "name": "u", "state": {"clarified": 0}, "tools": list(tools)}
    a["counterbalance"] = {"checkpoints": [{"tool": "user.ask", "allow_set_keys": ["clarified"]}]}
    a.update(extra)
    return a


def write_answers(d: Path, rows):
    (d / "answers.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")


def test_recorded_user_channel_answers_and_marks_user_tool(tmp_path: Path):
    write_answers(tmp_path, [{"tool": "user.ask", "result": {"output": {"answer": "replacement"}, "state_transition": {"set": {"clarified": 1}}}}])
    dep = {"bindings": {"user.ask": {"user": {"source": "recorded", "answers": "answers.jsonl"}}}}
    a = agent(ASK)
    tools = resolve_tools_from_deployment(a, dep, harness_dir=str(tmp_path))
    assert tools.user_tools == {"user.ask"}
    rt = FaustRuntime(a, [{"type": "tool", "name": "user.ask", "args": {"question": "refund?"}}], tools)
    rt.run_loop()
    events_to_jsonl(rt.events)
    ex = [e for e in rt.events if e["stage"] == "execute"][0]
    assert ex["result"] == {"answer": "replacement"} and rt.agent["state"]["clarified"] == 1


def test_answers_resolve_against_the_deployment_directory(tmp_path: Path):
    dep_dir = tmp_path / "deployments"
    dep_dir.mkdir()
    write_answers(dep_dir, [{"tool": "user.ask", "result": {"output": {"answer": "x"}}}])
    dep = {"bindings": {"user.ask": {"user": {"source": "recorded", "answers": "answers.jsonl"}}}}
    tools = resolve_tools_from_deployment(agent(ASK), dep, harness_dir=str(tmp_path), deployment_path=str(dep_dir / "d.yml"))
    assert tools["user.ask"]({}, {})["output"] == {"answer": "x"}
    with pytest.raises(AdapterError):  # not found relative to the harness dir
        resolve_tools_from_deployment(agent(ASK), dep, harness_dir=str(tmp_path))


def test_unbound_user_channel_has_no_handler_and_is_denied(tmp_path: Path):
    a = agent(ASK)
    tools = resolve_tools_from_deployment(a, {"bindings": {}}, harness_dir=str(tmp_path))
    assert "user.ask" not in tools
    rt = FaustRuntime(a, [{"type": "tool", "name": "user.ask", "args": {}}], tools)
    rt.run_loop()
    assert rt.events[1]["reason"] == "capability_missing" and rt.events[1]["stage"] == "validate"


def test_channel_user_tools_only_accept_user_bindings(tmp_path: Path):
    with pytest.raises(AdapterError, match="declares channel user"):
        resolve_tools_from_deployment(agent(ASK), {"bindings": {"user.ask": {"native": "stub.approve"}}})


@pytest.mark.parametrize("native", ["stub.ask", "user.ask"])
def test_self_answering_natives_removed(native):
    with pytest.raises(AdapterError, match="was removed"):
        resolve_tools_from_deployment(agent({"id": "user.ask"}), {"bindings": {"user.ask": {"native": native}}})


@pytest.mark.parametrize("native", ["local.user_ask", "local.user_ask_auto"])
def test_local_user_natives_never_bind_on_the_python_host(native):
    with pytest.raises(AdapterError):  # local.* is TS-only; there the native is reported as removed
        resolve_tools_from_deployment(agent({"id": "user.ask"}), {"bindings": {"user.ask": {"native": native}}})


def test_native_and_user_together_rejected(tmp_path: Path):
    write_answers(tmp_path, [])
    dep = {"bindings": {"user.ask": {"native": "x", "user": {"source": "recorded", "answers": "answers.jsonl"}}}}
    with pytest.raises(AdapterError, match="both native and user"):
        resolve_tools_from_deployment(agent(ASK), dep, harness_dir=str(tmp_path))


def test_human_source_uses_host_callback(tmp_path: Path):
    seen = []

    def human(req):
        seen.append(req)
        return {"output": {"answer": "yes please"}, "set": {"clarified": 1}}

    dep = {"bindings": {"user.ask": {"user": {"source": "human"}}}}
    tools = resolve_tools_from_deployment(agent(ASK), dep, user_channel={"human_answer": human})
    env = tools["user.ask"]({"question": "q"}, {})
    assert env == {"output": {"answer": "yes please"}, "state_transition": {"set": {"clarified": 1}}}
    assert seen[0]["allow_set_keys"] == ["clarified"]


# --- simulator source -------------------------------------------------------------------


class _FakeOpenAI(BaseHTTPRequestHandler):
    replies: list = []
    requests: list = []

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        type(self).requests.append({"path": self.path, "auth": self.headers.get("Authorization"), "body": body})
        content = type(self).replies.pop(0)
        payload = json.dumps({"choices": [{"message": {"role": "assistant", "content": content}}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *a):  # silence
        pass


@pytest.fixture
def fake_openai(monkeypatch):
    server = HTTPServer(("127.0.0.1", 0), _FakeOpenAI)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    monkeypatch.setenv("SIM_TEST_KEY", "test-key-not-a-secret")
    _FakeOpenAI.requests = []
    yield f"http://127.0.0.1:{server.server_address[1]}/v1"
    server.shutdown()


def test_simulator_source_validates_retries_and_keeps_context_private(tmp_path: Path, fake_openai):
    (tmp_path / "persona.md").write_text("You are Dana, a customer.", encoding="utf-8")
    (tmp_path / "hidden.md").write_text("You want a replacement, not a refund.", encoding="utf-8")
    _FakeOpenAI.replies = [
        "sure, a replacement",  # not JSON → one retry
        '```json\n{"output": {"answer": "replacement"}, "set": {"clarified": 1}}\n```',
    ]
    dep = {
        "model": {"transport": "recorded"},
        "bindings": {
            "user.ask": {
                "user": {
                    "source": "simulator",
                    "model": "sim-model",
                    "base_url": fake_openai,
                    "api_key_env": "SIM_TEST_KEY",
                    "system_prompt_file": "persona.md",
                    "context_file": "hidden.md",
                }
            }
        },
    }
    transcript: list = []
    tools = resolve_tools_from_deployment(agent(ASK), dep, harness_dir=str(tmp_path), user_channel={"transcript": transcript})
    env = tools["user.ask"]({"question": "refund or replacement?"}, {})
    assert env == {"output": {"answer": "replacement"}, "state_transition": {"set": {"clarified": 1}}}
    first = _FakeOpenAI.requests[0]
    assert first["path"] == "/v1/chat/completions" and first["auth"] == "Bearer test-key-not-a-secret"
    assert first["body"]["temperature"] == 0 and first["body"]["model"] == "sim-model" and "tools" not in first["body"]
    system = first["body"]["messages"][0]["content"]
    assert "Dana" in system and "replacement, not a refund" in system  # hidden context: simulator only
    assert '"set" is optional and may only contain these keys: clarified (integer).' in system
    assert len(_FakeOpenAI.requests) == 2 and "could not be used" in _FakeOpenAI.requests[1]["body"]["messages"][-1]["content"]
    assert transcript[0]["source"] == "simulator" and transcript[0]["simulator"]["responses"][0] == "sure, a replacement"


def test_simulator_rejects_disallowed_set_then_fails_closed(tmp_path: Path, fake_openai):
    _FakeOpenAI.replies = [
        '{"output": {"answer": "x"}, "set": {"plan_approved": 1}}',
        '{"output": {"answer": 5}}',
    ]
    dep = {"model": {}, "bindings": {"user.ask": {"user": {"source": "simulator", "model": "m", "base_url": fake_openai, "api_key_env": "SIM_TEST_KEY"}}}}
    tools = resolve_tools_from_deployment(agent(ASK), dep, harness_dir=str(tmp_path))
    with pytest.raises(AdapterError) as e:
        tools["user.ask"]({}, {})
    assert e.value.code == "user_channel_unavailable"


def test_simulator_without_api_key_fails_closed_at_bind(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("NO_SUCH_KEY_ENV", raising=False)
    dep = {"model": {}, "bindings": {"user.ask": {"user": {"source": "simulator", "model": "m", "api_key_env": "NO_SUCH_KEY_ENV"}}}}
    with pytest.raises(AdapterError) as e:
        resolve_tools_from_deployment(agent(ASK), dep, harness_dir=str(tmp_path))
    assert e.value.code == "user_channel_unavailable"
