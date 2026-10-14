"""Binding decisions implemented in the Python twin (D3, D6–D11, D14) and PY-7/8/15/16/17."""
import pytest

from fausth.runtime import FaustRuntime, default_tools, events_to_jsonl, scope_covered

OBJ = {"type": "object", "additionalProperties": True}


def agent(tools, **extra):
    a = {
        "spec": "counterbalance-contract/v0.1",
        "name": "t",
        "state": {},
        "tools": [t if isinstance(t, dict) else {"id": t} for t in tools],
    }
    a.update(extra)
    return a


def run(a, proposals, tools=None, recorded=None, parse=True, steps=32, **kw):
    rt = FaustRuntime(a, proposals, tools if tools is not None else default_tools(a), recorded, parse_proposals=parse, **kw)
    rt.run_loop(steps)
    events_to_jsonl(rt.events)  # every log stays canonical (D3: never crash at the end)
    return rt


def call(name, **args):
    return {"type": "tool", "name": name, "args": args}


def find(rt, **match):
    return [e for e in rt.events if all(e.get(k) == v for k, v in match.items())]


# --- D6 / PY-16: spawn ------------------------------------------------------------


@pytest.mark.parametrize("spawn", [None, {}, {"allow": None}, {"allow": 1}, {"tighten_only": True}])
def test_spawn_denied_unless_allow_is_exactly_true(spawn):
    extra = {} if spawn is None else {"spawn": spawn}
    a = agent(["agent.spawn", "fs.read"], **extra)
    rt = run(a, [call("agent.spawn", tools=["fs.read"])])
    assert find(rt, stage="authorize", verdict="deny", reason="gate_denied")
    assert not find(rt, stage="execute")




def test_spawn_is_subject_to_permissions_tools():
    a = agent(["agent.spawn", "fs.read"], spawn={"allow": True}, permissions={"tools": ["fs.read"]})
    rt = run(a, [call("agent.spawn", tools=["fs.read"])])
    assert find(rt, stage="validate", verdict="deny", reason="capability_missing", tool="agent.spawn")


def test_child_budget_is_charged_to_parent():
    a = agent(["agent.spawn", "fs.read"], spawn={"allow": True}, limits={"max_steps": 10, "max_tool_calls": 3})
    child = [call("fs.read", path="src/app.ts"), call("fs.read", path="src/app.ts")]
    rt = run(a, [call("agent.spawn", tools=["fs.read"], proposals=child), call("fs.read", path="src/app.ts")])
    # parent used 1 call (spawn) + child 2 calls = 3 = max_tool_calls → next parent step is over budget
    assert rt.tool_calls == 3
    assert rt.events[-1]["reason"] == "limit_exceeded" and "depth" not in rt.events[-1]




# --- D7 / PY-17: scope normalization ----------------------------------------------


@pytest.mark.parametrize(
    "child,parents,covered",
    [
        ("src", ["src/"], True),
        ("src/", ["src"], True),
        ("./src//lib", ["src"], True),
        ("src/../etc", ["src/"], False),
        ("src2", ["src"], False),
        ("/", ["src/"], False),
        (".", ["src/"], False),
        ("anything/deep", ["."], True),
        ("x", ["src/.."], False),  # implicit root is not a grant
        ("x", ["/"], False),
    ],
)
def test_scope_covered_normalizes_segment_wise(child, parents, covered):
    assert scope_covered(child, parents) is covered




# --- D8: success = executed AND verified ------------------------------------------------


def _absence_agent(**extra):
    return agent(
        [
            {
                "id": "fs.write_scoped",
                "verify": [{"kind": "absence", "require": {"path": "result.out_of_scope", "eq": 0}, "otherwise": "deny"}],
            },
            "task.complete",
        ],
        state={"out_of_scope_writes": 0},
        permissions={"filesystem": {"write_scopes": ["src/"]}},
        limits={"continue_after_deny": True},
        **extra,
    )




def test_unverified_call_does_not_satisfy_sequences():
    a = _absence_agent(
        counterbalance={"sequences": [{"action": "task.complete", "require_prior_tools": ["fs.write_scoped"]}]}
    )
    rt = run(a, [call("fs.write_scoped", path="docs/x.md", content="x"), call("task.complete")])
    seq = find(rt, stage="authorize", reason="sequence_requirement_failed")[0]
    assert seq["failure"] == {"kind": "missing_prior_tools", "missing_prior_tools": ["fs.write_scoped"]}
    rt2 = run(a, [call("fs.write_scoped", path="src/x.ts", content="x"), call("task.complete")])
    assert find(rt2, stage="execute", verdict="allow", tool="task.complete")


def test_failed_verify_rolls_back_provenance():
    a = agent(
        [{"id": "echo.ping", "verify": [{"kind": "evidence", "require": {"path": "result.ok", "eq": 2}, "otherwise": "deny"}]}],
        counterbalance={},
    )
    recorded = [{"call_seq": 1, "tool": "echo.ping", "args": {}, "result": {"output": {"ok": 1}, "state_transition": {"set": {"k": 1}}}}]
    rt = run(a, [call("echo.ping")], recorded=recorded)
    assert "memory_provenance" not in rt.agent["counterbalance"] and "k" not in rt.agent["state"]


# --- D9: checkpoint authority before execution -----------------------------------------------


def test_checkpoint_args_denied_at_authorize_without_executing():
    calls = []
    a = agent(
        [{"id": "user.correct", "input": OBJ}],
        state={"open_todos": 1, "plan_approved": 0},
        counterbalance={"checkpoints": [{"tool": "user.correct", "allow_set_keys": ["open_todos"]}]},
    )
    tools = {"user.correct": lambda args, ctx: calls.append(args) or {"output": {"ok": 1}}}
    rt = run(a, [call("user.correct", set={"open_todos": 0, "plan_approved": 1})], tools=tools)
    deny = find(rt, stage="authorize", reason="checkpoint_authority_failed")[0]
    assert deny["failure"] == {"kind": "checkpoint_key", "checkpoint_key": "plan_approved"}
    assert calls == [] and not find(rt, stage="execute")




# --- D10 / PY-15: recovery takes the governed path ---------------------------------------------


def _greenhouse(**extra):
    base = agent(
        [
            {"id": "sensor.fan.read_percent", "read_only": True},
            {
                "id": "actuator.fan.set",
                "input": {"type": "object", "properties": {"percent": {"type": "integer"}}, "required": ["percent"]},
                "verify": [
                    {"kind": "effect", "observe": "sensor.fan.read_percent", "require": {"path": "observation.percent", "eq": 99}}
                ],
            },
        ],
        state={"fan_percent": 0},
        fallback_state={"fan_percent": 0},
        recovery={
            "on": "verify_effect_failed",
            "execute": {"tool": "actuator.fan.set", "args": {"percent": 0}},
            "verify": {"kind": "effect", "observe": "sensor.fan.read_percent", "require": {"path": "observation.percent", "eq": 0}},
        },
    )
    base.update(extra)
    return base










# --- D11 / PY-8: no harness-specific names in the engine -------------------------------------------






def test_completion_block_when_declared():
    a = agent(
        ["task.complete"],
        state={"x": 0},
        counterbalance={"orientation": {"emit_each_step": True}, "completion": {"tool": "task.complete", "require": {"path": "state.x", "eq": 1}}},
    )
    rt = run(a, [call("task.complete")])
    assert rt.events[0]["observation"]["completion"] == {"tool": "task.complete", "require_paths": ["state.x"], "ready": 0}
    assert find(rt, stage="authorize", reason="completion_gate_failed")


def test_evidence_failure_has_no_tool_specific_observation():
    a = agent([{"id": "shell.run_allowlisted", "verify": [{"kind": "evidence", "require": {"path": "result.exit_code", "eq": 0}}]}])
    rt = run(a, [call("shell.run_allowlisted", cmd="test")])
    v = find(rt, stage="verify", reason="verify_evidence_failed")[0]
    assert "observation" not in v and v["result"]["exit_code"] == 1


# --- PY-7: memory_stale once per staleness transition ------------------------------------------------


def test_ttl_staleness_emits_once_and_does_not_create_provenance():
    a = agent(
        ["echo.ping"],
        state={"evidence": 1},
        counterbalance={"invalidate_after": [{"ttl_steps": 1, "memory_keys": ["evidence"]}]},
        limits={"continue_after_deny": True},
    )
    rt = run(a, [call("echo.ping")] * 4)
    assert len(find(rt, reason="memory_stale")) == 1
    assert "memory_provenance" not in rt.agent["counterbalance"]




# --- D3: non-canonical numbers rejected where they enter -------------------------------------------------


def test_non_integral_tool_output_is_denied_not_a_crash():
    a = agent(["echo.ping"])
    recorded = [{"call_seq": 1, "tool": "echo.ping", "args": {}, "result": {"output": {"x": 1.5}}}]
    rt = run(a, [call("echo.ping")], recorded=recorded)
    ex = find(rt, stage="execute")[0]
    assert ex["verdict"] == "deny" and ex["reason"] == "output_schema_invalid"
    recorded2 = [{"call_seq": 1, "tool": "echo.ping", "args": {}, "result": {"output": {"x": 1.0}}}]
    rt2 = run(a, [call("echo.ping")], recorded=recorded2)
    assert find(rt2, stage="execute")[0]["result"] == {"x": 1}




# --- D14: the user cell ---------------------------------------------------------------------------------


def _user_agent(**extra):
    return agent(
        [{"id": "user.approve", "channel": "user", "input": OBJ}, {"id": "fs.write_scoped", "input": OBJ}, "user.correct"],
        state={"plan_approved": 0, "open_todos": 1},
        permissions={"filesystem": {"write_scopes": ["src/"]}},
        counterbalance={
            "checkpoints": [
                {"tool": "user.approve", "allow_set_keys": ["plan_approved"]},
                {"tool": "user.correct", "allow_set_keys": ["open_todos", "plan_approved"]},
            ]
        },
        **extra,
    )


def test_unbound_user_channel_is_capability_missing():
    rt = run(_user_agent(), [call("user.approve", plan="p")])
    assert find(rt, stage="validate", verdict="deny", reason="capability_missing", tool="user.approve")
    assert not find(rt, stage="execute")




def test_recorded_or_bound_user_channel_answers():
    a = _user_agent()
    recorded = [
        {"call_seq": 1, "tool": "user.approve", "args": {"plan": "p"}, "result": {"output": {"approved": 1}, "state_transition": {"set": {"plan_approved": 1}}}}
    ]
    rt = run(a, [call("user.approve", plan="p")], recorded=recorded)
    assert rt.agent["state"]["plan_approved"] == 1
    bound = {"user.approve": lambda args, ctx: {"output": {"approved": 1}, "state_transition": {"set": {"plan_approved": 1}}}}
    rt2 = run(a, [call("user.approve", plan="p")], tools=bound, user_tools={"user.approve"})
    assert rt2.agent["state"]["plan_approved"] == 1


