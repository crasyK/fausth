"""Runtime parity with the TS engine (PY-2, PY-6, PY-9, PY-10, PY-18)."""
import json

from fausth.canonical import canonical_json
from fausth.runtime import FaustRuntime, default_tools, events_to_jsonl, normalize_envelope, simulation_tool_pool

PERMISSIVE = {"type": "object", "additionalProperties": True}


def agent(tools, **extra):
    a = {
        "spec": "counterbalance-contract/v0.1",
        "name": "t",
        "state": {},
        "tools": [t if isinstance(t, dict) else {"id": t} for t in tools],
    }
    a.update(extra)
    return a


def run(a, proposals, tools=None, recorded=None, parse=True, steps=32):
    rt = FaustRuntime(a, proposals, tools if tools is not None else default_tools(a), recorded, parse_proposals=parse)
    rt.run_loop(steps)
    # every log must serialize canonically
    events_to_jsonl(rt.events)
    return rt


def stages(rt):
    return [(e["stage"], e.get("verdict"), e.get("reason")) for e in rt.events]


# --- PY-2 / D5 ----------------------------------------------------------------


def test_empty_permissions_tools_permits_nothing():
    a = agent(["echo.ping"], permissions={"tools": []})
    rt = run(a, [{"type": "tool", "name": "echo.ping", "args": {}}])
    assert stages(rt)[1] == ("validate", "deny", "capability_missing")
    assert not any(e["stage"] == "execute" for e in rt.events)


def test_absent_permissions_tools_permits_all_declared():
    a = agent(["echo.ping"])
    rt = run(a, [{"type": "tool", "name": "echo.ping", "args": {"message": "x"}}])
    ex = [e for e in rt.events if e["stage"] == "execute"][0]
    assert ex["verdict"] == "allow" and ex["result"] == {"ok": 1, "echo": "x"}


# --- PY-6: proposal shapes ----------------------------------------------------


def test_tool_alias_and_missing_args_in_recorded_lines():
    a = agent(["echo.ping"])
    rt = run(a, [{"type": "tool", "tool": "echo.ping"}])
    assert rt.events[0]["tool"] == "echo.ping" and rt.events[0]["args"] == {}


def test_invalid_proposal_emits_empty_proposal_like_ts():
    a = agent(["echo.ping"])
    rt = run(a, [{"type": "invalid", "reason": "no_tool_call", "message": "hmm"}], parse=False)
    ev = rt.events[0]
    assert (ev["stage"], ev["verdict"], ev["reason"], ev["error"]) == ("propose", "deny", "empty_proposal", "hmm")
    assert ev["observation"] == {"invalid_reason": "no_tool_call", "stop_message": "hmm"}
    assert len(rt.events) == 1  # deny is terminal by default


def test_empty_proposals_capped_even_with_continue_after_deny():
    a = agent(["echo.ping"], limits={"continue_after_deny": True})
    inv = {"type": "invalid", "reason": "x"}
    rt = run(a, [inv, inv, inv], parse=False)
    assert [e["reason"] for e in rt.events] == ["empty_proposal", "empty_proposal"]
    assert rt.events[0]["observation"] == {"invalid_reason": "x", "stop_message": None}


def test_stop_message_truthiness_and_code_point_truncation():
    a = agent(["echo.ping"])
    assert "observation" not in run(a, [{"type": "stop", "message": ""}]).events[0]
    long = "\U0001F600" * 600
    rt = run(a, [{"type": "stop", "message": long}])
    assert rt.events[0]["observation"]["stop_message"] == "\U0001F600" * 500  # D2: code points


# --- PY-18: envelopes, nulls, provenance, error texts --------------------------


def test_normalize_envelope_keeps_null_and_array_outputs():
    assert normalize_envelope({"output": None}) == {"output": None}
    assert normalize_envelope({"output": [1, 2]}) == {"output": [1, 2]}
    assert normalize_envelope({"ok": 1}) == {"output": {"ok": 1}}
    assert normalize_envelope([1]) == {"output": [1]}


def test_null_result_is_kept_in_events():
    a = agent(["echo.ping"])
    recorded = [{"call_seq": 1, "tool": "echo.ping", "args": {}, "result": {"output": None}}]
    rt = run(a, [{"type": "tool", "name": "echo.ping", "args": {}}], recorded=recorded)
    ex = [e for e in rt.events if e["stage"] == "execute"][0]
    assert "result" in ex and ex["result"] is None
    assert '"result":null' in canonical_json(ex)


def test_false_write_refreshes_provenance_like_ts():
    a = agent([{"id": "echo.ping"}], counterbalance={})
    recorded = [
        {"call_seq": 1, "tool": "echo.ping", "args": {}, "result": {"output": {}, "state_transition": {"set": {"flag": False, "zero": 0}}}}
    ]
    rt = run(a, [{"type": "tool", "name": "echo.ping", "args": {}}], recorded=recorded)
    mp = rt.agent["counterbalance"]["memory_provenance"]
    assert "flag" in mp and "zero" not in mp


def test_transcript_mismatch_and_missing_handler_messages_match_ts():
    a = agent(["echo.ping", "custom.x"])
    recorded = [{"call_seq": 1, "tool": "other", "args": {}, "result": {}}]
    rt = run(a, [{"type": "tool", "name": "echo.ping", "args": {"m": 1}}], recorded=recorded)
    ex = [e for e in rt.events if e["stage"] == "execute"][0]
    assert ex["error"] == (
        'Recorded transcript mismatch: expected call_seq=1 tool=echo.ping args={"m":1}, got call_seq=1 tool=other'
    )
    rt2 = run(a, [{"type": "tool", "name": "custom.x", "args": {}}])
    ex2 = [e for e in rt2.events if e["stage"] == "execute"][0]
    assert ex2["reason"] == "tool_execution_failed" and ex2["error"] == "No native handler for custom.x"


def test_handler_errors_use_js_messages():
    # spawn children receive raw proposals; missing args reach the handler as undefined
    a = agent(["agent.spawn", "fs.read"], spawn={"allow": True})
    rt = run(a, [{"type": "tool", "name": "agent.spawn", "args": {"tools": ["fs.read"], "proposals": [{"type": "tool", "name": "fs.read"}]}}])
    child = [e for e in rt.events if e.get("depth") == 1 and e["stage"] == "execute"][0]
    assert child["error"] == "Cannot read properties of undefined (reading 'path')"


# --- PY-9: default (replay) world identical to TS cli.ts buildTools ----------------


def call(world, tool, args):
    return world[tool](args, {"state": {}})


def test_replay_world_files_and_no_self_answering_user_stub():
    a = agent(["fs.read"])
    w = default_tools(a)
    assert call(w, "fs.read", {"path": "src/app.js"})["output"] == {
        "path": "src/app.js",
        "content": 'export function greet(){ return "hello"; }\n',
        "found": 1,
    }
    # D14 (TS world after the edge WP): no user.ask stub that echoes the model's question
    assert "user.ask" not in w
    assert "tau.invoke" not in w and "todo.complete" not in w


def test_secrets_without_paths_or_values_do_not_activate_leak_fields():
    fs = {"filesystem": {"write_scopes": ["src/"]}}
    a = agent(["fs.write_scoped"], permissions={**fs, "secrets": {"deny_write_contains": True}})
    out = call(default_tools(a), "fs.write_scoped", {"path": "src/x.ts", "content": "c"})["output"]
    assert out == {"ok": 1, "out_of_scope": 0, "path": "src/x.ts"}
    a2 = agent(["fs.write_scoped"], permissions={**fs, "secrets": {"values": ["  sk-live  "]}})
    out2 = call(default_tools(a2), "fs.write_scoped", {"path": "src/x.ts", "content": "sk-live"})["output"]
    assert out2["secret_leak"] == 1


def test_no_tau_specific_world_logic():
    a = agent(["fs.write_scoped"], permissions={"filesystem": {"write_scopes": ["tau/"]}})
    env = call(default_tools(a), "fs.write_scoped", {"path": "tau/final.txt", "content": "done"})
    assert "state_transition" not in env
    env2 = call(default_tools(a), "fs.write_scoped", {"path": "tau/todos.json", "content": json.dumps({"slots": [{"value": 1}]})})
    assert "state_transition" not in env2


def test_world_coercions_follow_js():
    a = agent(["echo.ping", "actuator.fan.set", "kb.lookup"])
    w = default_tools(a)
    assert call(w, "echo.ping", {"message": True})["output"]["echo"] == "true"
    assert call(w, "echo.ping", {"message": None})["output"]["echo"] == "pong"
    assert call(w, "echo.ping", {"message": [1, None, 2]})["output"]["echo"] == "1,,2"
    assert call(w, "actuator.fan.set", {"percent": "50"})["output"] == {"ok": 1, "percent": 50}
    # D2: kb.lookup truncates the query to 24 code points
    q = "\U0001F600" * 30
    assert call(w, "kb.lookup", {"query": q})["output"]["article_id"] == "kb-" + "\U0001F600" * 24


def test_simulation_pool_matches_ts_build_handler_pool():
    a = agent(["shell.run_allowlisted", "fs.read"], permissions={"filesystem": {"write_scopes": ["src/"]}})
    w = simulation_tool_pool(a)
    # TS createSimulationWorldForAgent: the agent's own policy on simulated I/O; tests pass
    # by default and a passing test sets evidence like the local adapter.
    assert call(w, "shell.run_allowlisted", {"cmd": "test"}) == {
        "output": {"exit_code": 0, "cmd": "test"},
        "state_transition": {"set": {"test_evidence_current": 1}},
    }
    assert call(w, "fs.read", {"path": "src/app.js"})["output"]["found"] == 0
    w2 = simulation_tool_pool(a, test_exit=3)
    assert call(w2, "shell.run_allowlisted", {"cmd": "typecheck"}) == {"output": {"exit_code": 3, "cmd": "typecheck"}}


def test_world_policy_absent_scopes_and_normalized_paths():
    # absent write scopes = no writes; absent read scopes = unrestricted reads (TS EDGE-20)
    w = default_tools(agent(["fs.write_scoped", "fs.read"]))
    denied = call(w, "fs.write_scoped", {"path": "src/x.ts", "content": "x"})
    assert denied["output"]["out_of_scope"] == 1
    assert call(w, "fs.read", {"path": "./src//app.ts"})["output"] == {"path": "src/app.ts", "content": "export {}", "found": 1}
    a = agent(["fs.write_scoped", "fs.read"], permissions={"filesystem": {"write_scopes": ["src"], "read_scopes": []}})
    w2 = default_tools(a)
    assert call(w2, "fs.read", {"path": "src/app.ts"})["output"]["error"] == "scope_denied"  # [] = nothing
    assert call(w2, "fs.read", {"path": "../etc/passwd"})["output"]["error"] == "path_escape"
    assert call(w2, "fs.write_scoped", {"path": "src/../x", "content": "x"})["output"]["error"] == "path_escape"
    assert call(w2, "fs.write_scoped", {"path": ".fausth/x", "content": "x"})["output"]["out_of_scope"] == 1
    ok = call(w2, "fs.write_scoped", {"path": "./src/new.ts", "content": "x"})["output"]
    assert ok["ok"] == 1 and ok["path"] == "src/new.ts"


# --- PY-10 / D2: message lengths count code points ----------------------------------


def test_output_verify_message_length_counts_code_points():
    a = agent(
        [{"id": "answer.send", "verify": [{"kind": "output", "require": {"path": "message.length", "lte": 3}}]}]
    )
    rt = run(a, [{"type": "tool", "name": "answer.send", "args": {"message": "\U0001F600\U0001F680\U0001F600"}}])
    v = [e for e in rt.events if e["stage"] == "verify"][0]
    assert v["verdict"] == "allow" and v["observation"]["message"]["length"] == 3


def test_run_loop_without_host_cap_enforces_ir_limits():
    a = agent(["echo.ping"], limits={"max_steps": 2, "continue_after_deny": True})
    rt = FaustRuntime(a, [{"type": "tool", "name": "echo.ping", "args": {}}] * 5, default_tools(a))
    rt.run_loop(None)
    assert rt.events[-1]["reason"] == "limit_exceeded" and rt.steps == 2


def test_callable_propose_handles_invalid_proposals_natively():
    a = agent(["echo.ping"], limits={"continue_after_deny": True})
    queue = [
        {"type": "invalid", "reason": "no_tool_call", "message": "thinking…"},
        {"type": "tool", "name": "echo.ping", "args": {}},
        {"type": "stop"},
    ]
    rt = FaustRuntime(a, lambda: queue.pop(0) if queue else {"type": "stop"}, default_tools(a))
    rt.run_loop()
    assert rt.events[0]["reason"] == "empty_proposal" and rt.events[0]["error"] == "thinking…"
    assert any(e["stage"] == "execute" and e["verdict"] == "allow" for e in rt.events)
