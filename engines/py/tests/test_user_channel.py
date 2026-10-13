"""D14: fausth-py user channel — recorded answers, never the model's own args."""
from __future__ import annotations

import json

import pytest

from fausth.adapter_error import AdapterError
from fausth.user_channel import (
    check_user_set,
    coerce_human_answer,
    create_user_channel_handler,
    parse_user_channel_binding,
)

ASK = {
    "id": "user.ask",
    "output": {"type": "object", "required": ["answer"], "properties": {"answer": {"type": "string"}}},
}


@pytest.fixture()
def answers_dir(tmp_path):
    rows = [
        {"tool": "user.ask", "call_seq": 2, "result": {"output": {"answer": "second"}}},
        {
            "tool": "user.ask",
            "args": {"question": "refund or replacement?"},
            "result": {"output": {"answer": "replacement"}, "state_transition": {"set": {"clarified": 1}}},
        },
    ]
    (tmp_path / "answers.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
    return tmp_path


def test_recorded_matches_args_and_call_seq(answers_dir):
    transcript: list = []
    h = create_user_channel_handler(
        ASK,
        parse_user_channel_binding("user.ask", {"source": "recorded", "answers": "answers.jsonl"}),
        base_dir=answers_dir,
        transcript=transcript,
    )
    assert h({"question": "refund or replacement?"}, {}) == {
        "output": {"answer": "replacement"},
        "state_transition": {"set": {"clarified": 1}},
    }
    assert h({"question": "anything"}, {}) == {"output": {"answer": "second"}}
    with pytest.raises(AdapterError) as ei:
        h({"question": "third"}, {})
    assert ei.value.code == "user_channel_unavailable"
    assert [t["source"] for t in transcript] == ["recorded", "recorded"]


def test_model_supplied_answer_is_never_echoed(answers_dir):
    h = create_user_channel_handler(
        ASK,
        parse_user_channel_binding("user.ask", {"source": "recorded", "answers": "answers.jsonl"}),
        base_dir=answers_dir,
    )
    with pytest.raises(AdapterError):
        h({"question": "refund or replacement?", "answer": "yes, do it"}, {})


def test_answers_path_is_contained(answers_dir):
    for bad in ("../answers.jsonl", "/etc/passwd"):
        with pytest.raises(AdapterError):
            create_user_channel_handler(
                ASK,
                parse_user_channel_binding("user.ask", {"source": "recorded", "answers": bad}),
                base_dir=answers_dir,
            )


def test_closed_source_set_and_py_simulator_refusal(answers_dir):
    with pytest.raises(AdapterError):
        parse_user_channel_binding("user.ask", {"source": "auto"})
    with pytest.raises(AdapterError):
        parse_user_channel_binding("user.ask", {"source": "recorded"})
    binding = parse_user_channel_binding("user.ask", {"source": "simulator", "model": "kit.glm-5.3-flash"})
    with pytest.raises(AdapterError) as ei:
        create_user_channel_handler(ASK, binding, base_dir=answers_dir)
    assert ei.value.code == "user_channel_unavailable"


def test_human_callback_and_coercion(answers_dir):
    h = create_user_channel_handler(
        ASK,
        parse_user_channel_binding("user.ask", {"source": "human"}),
        base_dir=answers_dir,
        human_answer=lambda req: {"output": {"answer": f"human saw {req['args']['question']}"}},
    )
    assert h({"question": "q?"}, {}) == {"output": {"answer": "human saw q?"}}
    schema = {"required": ["approved"], "properties": {"approved": {"type": "integer"}}}
    assert coerce_human_answer("yes", schema) == {"output": {"approved": 1}}
    assert coerce_human_answer("maybe", schema) is None


def test_user_set_must_match_ir_state_type():
    assert check_user_set({"clarified": 1}, ["clarified"], {"clarified": "integer"}) is None
    assert "integer" in check_user_set({"clarified": "wants_replacement"}, ["clarified"], {"clarified": "integer"})
    assert "non-integral" in check_user_set({"clarified": 0.5}, ["clarified"], {"clarified": "integer"})
    assert "may only contain" in check_user_set({"other": 1}, ["clarified"], {})


def test_human_set_is_validated(answers_dir):
    h = create_user_channel_handler(
        ASK,
        parse_user_channel_binding("user.ask", {"source": "human"}),
        base_dir=answers_dir,
        allow_set_keys=["clarified"],
        state_types={"clarified": "integer"},
        human_answer=lambda req: {"output": {"answer": "x"}, "set": {"clarified": "yes"}},
    )
    with pytest.raises(AdapterError):
        h({"question": "q?"}, {})
