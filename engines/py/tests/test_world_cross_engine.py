"""Cross-engine: the default (replay) and deployment (simulation) worlds must answer the
same tool calls with the same envelopes in TS and Python (PY-9, edge EDGE-20 policy)."""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
RUNNERS = ROOT / "conformance" / "fuzz" / "runners"
TSX = ROOT / "engines" / "ts" / "node_modules" / "tsx"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None or not TSX.exists(), reason="node + tsx needed for the TS side"
)

CALLS = [
    {"tool": "fs.read", "args": {"path": "src/app.ts"}},
    {"tool": "fs.read", "args": {"path": "./src//app.js"}},
    {"tool": "fs.read", "args": {"path": "secrets/key.txt"}},
    {"tool": "fs.read", "args": {"path": "../etc/passwd"}},
    {"tool": "fs.read", "args": {"path": "docs/readme.md"}},
    {"tool": "fs.read", "args": {}},
    {"tool": "fs.list", "args": {"path": "src"}},
    {"tool": "fs.list", "args": {"path": "."}},
    {"tool": "fs.write_scoped", "args": {"path": "src/new.ts", "content": "x"}},
    {"tool": "fs.write_scoped", "args": {"path": "./src/../x.ts", "content": "x"}},
    {"tool": "fs.write_scoped", "args": {"path": ".fausth/approved_paths.json", "content": "{}"}},
    {"tool": "fs.write_scoped", "args": {"path": ".", "content": "x"}},
    {"tool": "fs.write_scoped", "args": {"path": "src/leak.ts", "content": "k=sk-fixture-secret-0001"}},
    {"tool": "fs.write_scoped", "args": {"path": "src/app.js", "content": "tampered"}},
    {"tool": "shell.run_allowlisted", "args": {"cmd": "test"}},
    {"tool": "shell.run_allowlisted", "args": {"cmd": "rm"}},
    {"tool": "kb.lookup", "args": {"query": "refund policy and much more text"}},
    {"tool": "echo.ping", "args": {"message": [1, None, 2]}},
    {"tool": "user.ask", "args": {"question": "q"}},
    {"tool": "user.approve", "args": {}},
    {"tool": "agent.spawn", "args": {"tools": ["fs.read"]}},
    {"tool": "actuator.fan.set", "args": {"percent": 55}},
]

AGENTS = {
    "no-permissions": {"spec": "counterbalance-contract/v0.1", "name": "w", "state": {}, "tools": []},
    "scoped": {
        "spec": "counterbalance-contract/v0.1",
        "name": "w",
        "state": {"fan_percent": 10},
        "tools": [],
        "permissions": {
            "filesystem": {"write_scopes": ["src"], "read_scopes": ["src/", "secrets"]},
            "secrets": {"paths": ["secrets/key.txt"]},
            "protected_paths": ["src/app.js"],
        },
    },
    "empty-read-scopes": {
        "spec": "counterbalance-contract/v0.1",
        "name": "w",
        "state": {},
        "tools": [],
        "permissions": {"filesystem": {"write_scopes": ["."], "read_scopes": []}},
    },
}


def _requests():
    reqs = []
    for name, agent in AGENTS.items():
        for world in ("replay", "simulation"):
            a = dict(agent)
            if world == "simulation":
                a = {**agent, "tools": [{"id": c["tool"]} for c in CALLS if c["tool"] not in ("echo.ping", "user.ask", "user.approve")]}  # user cell: no world binding (D14)
            reqs.append({"id": f"{name}/{world}", "kind": "world", "world": world, "agent": a, "calls": CALLS})
    return "\n".join(json.dumps(r) for r in reqs) + "\n"


def _run(cmd, cwd, env=None):
    r = subprocess.run(cmd, cwd=cwd, input=_requests(), capture_output=True, text=True, encoding="utf-8", env=env, timeout=300)
    assert r.returncode == 0, r.stderr
    return {json.loads(l)["id"]: json.loads(l) for l in r.stdout.splitlines() if l.strip()}


def test_default_worlds_identical_across_engines():
    ts = _run(["node", "--import", "tsx", str(RUNNERS / "ts-runner.ts")], cwd=ROOT / "engines" / "ts")
    env = {**os.environ, "PYTHONPATH": str(ROOT / "engines" / "py")}
    py = _run([sys.executable, str(RUNNERS / "py_runner.py")], cwd=ROOT, env=env)
    assert ts.keys() == py.keys()
    for k in ts:
        assert ts[k]["ok"] and py[k]["ok"], (k, ts[k], py[k])
        assert ts[k]["out"] == py[k]["out"], k
