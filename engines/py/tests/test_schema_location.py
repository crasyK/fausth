"""PY-20: schemas are found without assuming the package's depth in the repo."""
import os
import shutil
import subprocess
import sys
from pathlib import Path

from fausth.validate import schema_path, validate_agent

ENGINE = Path(__file__).resolve().parents[1]
ROOT = ENGINE.parents[1]


def test_packaged_schema_copy_matches_repo_schema():
    packaged = ENGINE / "fausth" / "schema" / "counterbalance-contract.v0.1.json"
    canonical = ROOT / "schema" / "counterbalance-contract.v0.1.json"
    assert packaged.read_bytes() == canonical.read_bytes(), "re-copy schema/ into engines/py/fausth/schema/"


def test_repo_schema_preferred_in_checkout():
    assert schema_path() == (ROOT / "schema" / "counterbalance-contract.v0.1.json").resolve()


def test_env_override(tmp_path, monkeypatch):
    shutil.copy(ROOT / "schema" / "counterbalance-contract.v0.1.json", tmp_path / "counterbalance-contract.v0.1.json")
    monkeypatch.setenv("FAUSTH_SCHEMA_DIR", str(tmp_path))
    assert schema_path() == tmp_path / "counterbalance-contract.v0.1.json"


def test_validate_works_from_a_non_repo_install(tmp_path):
    site = tmp_path / "site-packages"
    shutil.copytree(ENGINE / "fausth", site / "fausth", ignore=shutil.ignore_patterns("__pycache__"))
    code = (
        "from fausth.validate import validate_agent, schema_path\n"
        "ok, errors, _ = validate_agent({'spec': 'counterbalance-contract/v0.1', 'name': 'x', 'state': {}, 'tools': [{'id': 'a'}]})\n"
        "print(ok, schema_path())\n"
    )
    env = {k: v for k, v in os.environ.items() if k not in ("FAUSTH_SCHEMA_DIR",)}
    env["PYTHONPATH"] = str(site)
    r = subprocess.run([sys.executable, "-c", code], cwd=tmp_path, env=env, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert r.stdout.startswith("True ") and str(site) in r.stdout


def test_validate_agent_rejects_bad_ir():
    ok, errors, _ = validate_agent({"spec": "counterbalance-contract/v0.1", "name": "", "state": {}, "tools": []})
    assert not ok and errors


# --- validator rules: SPEC-16, D7, D3 ---------------------------------------------

BASE = {"spec": "counterbalance-contract/v0.1", "name": "x", "state": {}, "tools": [{"id": "fs.read"}]}


def test_undeclared_permission_tool_is_rejected():
    ok, errors, _ = validate_agent({**BASE, "permissions": {"tools": ["fs.read", "shell.unrestricted"]}})
    assert not ok and any("shell.unrestricted" in e for e in errors)
    assert validate_agent({**BASE, "permissions": {"tools": []}})[0]


def test_invalid_filesystem_scopes_rejected():
    for bad in ("/", "../x", "src/..", "/etc", ".git"):
        ok, errors, _ = validate_agent({**BASE, "permissions": {"filesystem": {"write_scopes": [bad]}}})
        assert not ok, bad
    for good in (".", "src", "src/", "./src//lib", "*"):
        assert validate_agent({**BASE, "permissions": {"filesystem": {"read_scopes": [good]}}})[0], good


def test_non_canonical_ir_rejected():
    ok, errors, _ = validate_agent({**BASE, "gates": [{"require": {"path": "state.x", "eq": 1.5}}]})
    assert not ok and errors[0].startswith("non-canonical IR")
