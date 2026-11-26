"""The run loop's 0.6 parts that a replay fixture can't show: a host's own reasons (§8.1), `raw` (§14)."""
import pytest

from fausth.engine import run

HARNESS = {
    "spec": "harness/0.7", "name": "n", "prompt": "p",
    "tools": {"edit": {"description": "Edit.", "input": {"type": "object", "required": ["path"], "properties": {"path": {"type": "string"}}}}},
    "texts": {"invalid_arguments": 'Validation failed for tool "{tool}":\n{reasons}'},
}


class _Host:
    def __init__(self, reasons=None, call=None):
        self.replies = [{"tool_calls": [call or {"tool": "edit", "args": {"path": 3}}]}, {"text": "Done."}]
        self.asked = False
        if reasons is not None:
            self.reasons = reasons

    def user(self):
        if self.asked:
            return None
        self.asked = True
        return "Go."

    def model(self, request):
        return self.replies.pop(0)

    def call(self, id, input):
        return {"ok": True, "result": "x"}

    def interrupts(self, step):
        return []


def error_of(log):
    return next(e for e in log.entries if e["type"] == "tool_result")["error"]


def test_without_a_host_validator_the_reasons_are_the_engines():
    assert error_of(run(HARNESS, _Host())) == 'Validation failed for tool "edit":\npath: must be a string'


def test_a_host_may_give_its_own_validators_reasons():
    seen = []
    log = run(HARNESS, _Host(lambda tool, args: seen.append((tool, args)) or "  - path: expected string"))
    assert error_of(log) == 'Validation failed for tool "edit":\n  - path: expected string'
    assert seen == [("edit", {"path": 3})]


def test_none_means_the_engines_reasons_and_a_non_string_is_an_infrastructure_failure():
    assert error_of(run(HARNESS, _Host(lambda tool, args: None))) == 'Validation failed for tool "edit":\npath: must be a string'
    assert run(HARNESS, _Host(lambda tool, args: 3)).entries[-1]["reason"] == "infra_failure"


@pytest.mark.parametrize("call", [
    {"tool": "edit", "malformed": "{", "raw": "{"},  # raw only beside args
    {"tool": "edit", "args": {"path": "a"}, "raw": {"path": "a"}},  # raw is text
    {"tool": "edit", "args": {"path": "a"}, "raw": '{"path": "b"}'},  # and reads as args
    {"tool": "edit", "args": {"path": "a"}, "raw": '{"path": "a"'},
])
def test_a_raw_text_that_is_not_the_calls_arguments_breaks_the_interface(call):
    assert run(HARNESS, _Host(call=call)).entries[-1]["reason"] == "infra_failure"


def test_raw_may_differ_from_args_in_how_it_writes_them():
    call = {"tool": "edit", "args": {"path": "a", "n": 18446744073709551615}, "raw": '{ "n": 18446744073709551615, "path": "\\u0061" }'}
    log = run({**HARNESS, "argument_text": "sorted_ascii"}, _Host(call=call))
    assert log.entries[-1]["reason"] == "stop"
    assert next(e for e in log.entries if e["type"] == "assistant")["tool_calls"][0]["args_text"] == '{"n":18446744073709551615,"path":"a"}'


# 0.7 (§14): `finish` and `failure` are strings when a response has them.
@pytest.mark.parametrize("extra", [{"finish": 1}, {"failure": None}])
def test_finish_and_failure_must_be_strings(extra):
    host = _Host()
    host.replies = [{"text": "x", **extra}]
    assert run(HARNESS, host).entries[-1]["reason"] == "infra_failure"
