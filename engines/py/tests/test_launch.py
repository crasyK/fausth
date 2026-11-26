"""A binding that launches another Fausth run (§13.1): the harness it is handed, its own log and limits.

The two conformance fixtures are the two runs of Hermes Agent's title after the turn: v06-stop-context is the main
run, whose `stop` hook hands the title harness over in `with.harness` (its tools.jsonl records the binding's answers),
and v06-stop-title-run is the launched one. Here the binding runs live, and each run must still give its own
fixture's expected files.
"""
import json
import re
from pathlib import Path

import pytest

from fausth.engine import HostEnd, InfraFailure, run
from fausth.harness import read_harness
from fausth.launch import final_text, handed_harness, harness_binding
from fausth.values import canonical, parse_json

FIXTURES = Path(__file__).resolve().parents[3] / "conformance" / "fixtures"
MAIN, TITLE = FIXTURES / "v06-stop-context", FIXTURES / "v06-stop-title-run"
WRAPPER = re.compile(r"<system-reminder>.*?</system-reminder>\s*", re.S)
ALLOW = {"ok": True, "result": {"decision": "allow"}}


def lines(path):
    return [parse_json(line) for line in path.read_text("utf-8").split("\n") if line.strip()] if path.exists() else []


class Scripted:
    """Answers the model from `replies` (an exception is raised), bound ids from `live`, other ids from `tools`."""

    def __init__(self, replies, live=None, tools=(), user=()):
        self.replies, self.live, self.tools, self.users = list(replies), live or {}, list(tools), list(user)
        self.requests = []

    def user(self):
        return self.users.pop(0) if self.users else None

    def model(self, request):
        self.requests.append(request)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply

    def call(self, id, input):
        if id in self.live:
            return self.live[id](input)
        line = self.tools.pop(0)
        assert line["id"] == id
        return {k: v for k, v in line.items() if k != "id"}

    def interrupts(self, step):
        return []


def from_fixture(d, live):
    return Scripted(lines(d / "model.jsonl"), live, [t for t in lines(d / "tools.jsonl") if t["id"] not in live],
                    [u["text"] for u in lines(d / "user.jsonl")])


def harness_of(d):
    return read_harness((d / "harness.json").read_text("utf-8"))


def title_task(input):
    """The opening user message without the host's wrappers, cut to `with.max_chars` code points (Hermes: 1000)."""
    opening = next(m["text"] for m in input["context"] if m["role"] == "user")
    return WRAPPER.sub("", opening)[:input["with"]["max_chars"]]


def test_a_stop_handler_launches_the_harness_its_hook_hands_it_and_both_logs_stay_apart():
    saved, logs = {}, []

    def save_title(input):
        saved.update(json.loads(input["message"]))
        return ALLOW

    title_host = from_fixture(TITLE, {"save_title": save_title})
    launch = harness_binding(title_host, title_task, answer=lambda log: ALLOW, on_log=logs.append)
    main = run(harness_of(MAIN), from_fixture(MAIN, {"make_title": lambda input: ALLOW if saved else launch(input)}))

    # The caller's file holds the title harness (one resolved document, §2), and the binding runs that one.
    assert canonical(harness_of(MAIN)["hooks"][1]["with"]["harness"]) == canonical(harness_of(TITLE))
    # The caller's log holds only the binding's answers; the launched run has its own log and requests.
    assert main.text() == (MAIN / "expected.log.jsonl").read_text("utf-8")
    assert len(logs) == 1  # the second turn's stop finds the title saved and launches nothing
    assert logs[0].text() == (TITLE / "expected.log.jsonl").read_text("utf-8")
    assert "".join(canonical(r) + "\n" for r in title_host.requests) == \
        (TITLE / "expected.requests.jsonl").read_text("utf-8")
    assert saved == {"title": "Empty input in parser.py parse"}
    # No hook of the caller runs in the launched run (§13.1): its only hook is its own.
    assert [e["hook"] for e in logs[0].entries if e["type"] == "hook"] == ["save"]


SUMMARIZER = {"spec": "harness/0.7", "name": "summarizer", "prompt": "Summarize the text in one line."}
ORCHESTRATOR = {
    "spec": "harness/0.7", "name": "orchestrator", "prompt": "Delegate.",
    "tools": {"run_agent": {"description": "Run a sub-agent harness on a task.", "input": {
        "type": "object", "required": ["harness", "task"], "additionalProperties": False,
        "properties": {"harness": {"type": "object"}, "task": {"type": "string"}}}}},
    "limits": {"max_steps": 2},
}


def orchestrator_host(binding, harness=SUMMARIZER):
    """The orchestrator's model writes a sub-agent harness at runtime and hands it to `run_agent`."""
    replies = [{"tool_calls": [{"tool": "run_agent", "args": {"harness": harness, "task": "A long text."}}]},
               {"text": "Done."}]
    return Scripted(replies, {"run_agent": binding}, user=["Go."])


def task_argument(input):
    return input["task"]


def result_of(log):
    return next({k: e[k] for k in ("ok", "result", "error") if k in e} for e in log.entries if e["type"] == "tool_result")


def test_a_tool_launches_the_harness_the_model_wrote_and_answers_with_its_final_text():
    launched = Scripted([{"text": "Short.", "reasoning": "r"}])
    log = run(ORCHESTRATOR, orchestrator_host(harness_binding(launched, task_argument)))
    assert result_of(log) == {"ok": True, "result": "Short."}
    assert launched.requests[0] == {"system": "Summarize the text in one line.", "tools": [],
                                    "messages": [{"role": "user", "text": "A long text."}]}
    # Its steps and limits are its own: the orchestrator's max_steps 2 still allows its own two requests, and
    # nothing of the launched run is in its log.
    assert log.entries[-1]["reason"] == "stop"
    assert [e["type"] for e in log.entries].count("run_start") == 1 and all("depth" not in e for e in log.entries[1:])


@pytest.mark.parametrize("harness", [
    {**SUMMARIZER, "spec": "harness/0.5"},  # not valid
    {**SUMMARIZER, "tools": {"shell": {"description": "Run a command.", "input": {"type": "object"}}}},  # not bound
])
def test_a_handed_harness_that_cannot_run_is_world_feedback_for_a_tool(harness):
    launched = Scripted([])
    binding = harness_binding(launched, task_argument, binds=lambda id: id in ("read",))
    log = run(ORCHESTRATOR, orchestrator_host(binding, harness))
    assert result_of(log) == {"ok": False, "error": "child harness is not valid"}
    assert launched.requests == [] and log.entries[-1]["reason"] == "stop"


def test_a_handed_harness_that_cannot_run_fails_a_handlers_hook():
    caller = {"spec": "harness/0.7", "name": "c", "prompt": "p", "handlers": {"make_title": {}},
              "hooks": [{"id": "title", "on": "stop", "run": "make_title", "with": {"harness": {"name": "x"}}}]}
    log = run(caller, Scripted([{"text": "Hi."}], {"make_title": harness_binding(Scripted([]), lambda i: "t")}, user=["Hello."]))
    assert [e.get("decision") for e in log.entries if e["type"] == "hook"] == ["failed"]
    assert log.entries[-1]["reason"] == "infra_failure"  # on_failure: end (§5.4)


@pytest.mark.parametrize("reply", [InfraFailure("down"), HostEnd("left"), {"text": 3}])
def test_a_launched_run_that_ends_without_an_answer_is_the_bindings_infrastructure_failure(reply):
    logs = []
    binding = harness_binding(Scripted([reply]), task_argument, on_log=logs.append)
    with pytest.raises(InfraFailure):
        binding({"harness": SUMMARIZER, "task": "t"})
    assert logs[0].entries[-1]["reason"] in ("infra_failure", "host_end")  # the host still gets its log
    # In the caller: a tool's binding without an answer ends the run (§3.3) ...
    log = run(ORCHESTRATOR, orchestrator_host(harness_binding(Scripted([reply]), task_argument)))
    assert log.entries[-1]["reason"] == "infra_failure"
    # ... and fails a handler's hook, which on_failure: skip lets pass.
    caller = {"spec": "harness/0.7", "name": "c", "prompt": "p", "handlers": {"make_title": {}},
              "hooks": [{"id": "title", "on": "stop", "run": "make_title", "on_failure": "skip",
                         "with": {"harness": SUMMARIZER}}]}
    log = run(caller, Scripted([{"text": "Hi."}], {"make_title": harness_binding(Scripted([reply]), lambda i: "t")},
                               user=["Hello."]))
    assert [e.get("decision") for e in log.entries if e["type"] == "hook"] == ["failed"]
    assert log.entries[-1]["reason"] == "stop"


def test_a_task_that_is_not_a_string_is_an_infrastructure_failure():
    with pytest.raises(InfraFailure):
        harness_binding(Scripted([]), lambda input: None)({"harness": SUMMARIZER})


def test_the_handed_harness_and_the_final_text():
    assert handed_harness({"event": "stop", "with": {"harness": 1}, "harness": 2}) == 1
    assert handed_harness({"harness": 2}) == 2 and handed_harness({"event": "stop", "with": {}}) is None
    assert final_text(run(SUMMARIZER, Scripted([{"text": "One."}], user=["a"]))) == "One."
    assert final_text(run(SUMMARIZER, Scripted([InfraFailure("x")], user=["a"]))) == ""


# 0.7 (§2.1, §13.1): the binding fills the handed harness's host values first.
def test_a_launched_harness_gets_the_launching_hosts_values():
    handed = {**SUMMARIZER, "prompt": "Summarize in ${CWD} for ${OWNER}.", "host_values": ["OWNER"]}
    launched = Scripted([{"text": "One."}])
    binding = harness_binding(launched, task_argument, values={"CWD": "/app", "OWNER": "me"})
    assert binding({"harness": handed, "task": "t"}) == {"ok": True, "result": "One."}
    assert launched.requests[0]["system"] == "Summarize in /app for me."
    # one whose values can't be filled is not launched
    assert harness_binding(Scripted([]), task_argument, values={"CWD": "/app"})({"harness": handed, "task": "t"}) \
        == {"ok": False, "error": "child harness is not valid"}
