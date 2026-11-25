"""The run loop's 0.6 parts that a replay fixture can't show: a host's own reasons (§8.1)."""
from fausth.engine import run

HARNESS = {
    "spec": "harness/0.6", "name": "n", "prompt": "p",
    "tools": {"edit": {"description": "Edit.", "input": {"type": "object", "required": ["path"], "properties": {"path": {"type": "string"}}}}},
    "texts": {"invalid_arguments": 'Validation failed for tool "{tool}":\n{reasons}'},
}


class _Host:
    def __init__(self, reasons=None):
        self.replies = [{"tool_calls": [{"tool": "edit", "args": {"path": 3}}]}, {"text": "Done."}]
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
