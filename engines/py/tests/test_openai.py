from pathlib import Path

import pytest

from fausth.engine import InfraFailure
from fausth.openai import from_chat, to_chat
from fausth.values import parse_json

# Read as an engine reads JSON (§1): numbers are doubles.
VECTORS = parse_json((Path(__file__).resolve().parents[3] / "conformance" / "openai.json").read_text("utf-8"))


def test_request_to_chat():
    assert to_chat(VECTORS["request"], "m", {"temperature": 0}) == VECTORS["chat"]


@pytest.mark.parametrize("case", VECTORS["answers"], ids=lambda c: c["name"])
def test_answer_to_response(case):
    if case.get("error"):
        with pytest.raises(InfraFailure):
            from_chat(case["answer"], "kit")
        return
    assert from_chat(case["answer"], "kit") == case["response"]


@pytest.mark.parametrize("case", VECTORS["replay"]["cases"], ids=lambda c: c["reasoning_replay"])
def test_logged_reasoning_sent_back(case):
    assert to_chat(VECTORS["replay"]["request"], "m", None, case["reasoning_replay"]) == case["chat"]


@pytest.mark.parametrize("value", VECTORS["replay"]["invalid"])
def test_an_unknown_reasoning_replay_is_an_error(value):
    with pytest.raises(ValueError):
        to_chat(VECTORS["replay"]["request"], "m", None, value)
