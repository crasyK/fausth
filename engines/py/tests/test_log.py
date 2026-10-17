import json
from pathlib import Path

import pytest

from fausth.log import Log, Scope, call_id, view

VECTORS = json.loads((Path(__file__).resolve().parents[3] / "conformance" / "log.json").read_text("utf-8"))


def scope(s):
    return Scope(s["depth"], s.get("parent_call"))


def replay():
    log = Log()
    for a in VECTORS["appends"]:
        log.append(scope(a["scope"]), a["type"], a["members"])
    return log


def test_log_text():
    assert replay().text() == VECTORS["text"]


@pytest.mark.parametrize("case", VECTORS["views"], ids=lambda c: json.dumps(c["scope"]))
def test_view(case):
    assert view(replay().entries, scope(case["scope"])) == case["view"]


def test_call_ids():
    for seq, index, cid in VECTORS["call_ids"]:
        assert call_id(seq, index) == cid


def test_every_entry_type_appears():
    types = {a["type"] for a in VECTORS["appends"]}
    assert types >= {"run_start", "system", "user", "assistant", "hook", "tool_result", "interrupt", "harness_changed", "run_end"}
