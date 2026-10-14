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








# --- PY-18: envelopes, nulls, provenance, error texts --------------------------


def test_normalize_envelope_keeps_null_and_array_outputs():
    assert normalize_envelope({"output": None}) == {"output": None}
    assert normalize_envelope({"output": [1, 2]}) == {"output": [1, 2]}
    assert normalize_envelope({"ok": 1}) == {"output": {"ok": 1}}
    assert normalize_envelope([1]) == {"output": [1]}










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


