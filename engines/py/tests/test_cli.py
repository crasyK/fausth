"""CLI wiring (PY-20): validate, replay [dir], audit, run --apply-overlays."""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
ROOT = ENGINE.parents[1]


def cli(*args, cwd=None, env_extra=None):
    env = dict(os.environ)
    env["PYTHONPATH"] = str(ENGINE)
    env.update(env_extra or {})
    return subprocess.run(
        [sys.executable, "-m", "fausth", *args], cwd=cwd or ROOT, env=env, capture_output=True, text=True, encoding="utf-8"
    )


def test_validate_prints_canonical_ir():
    r = cli("validate", "examples/greenhouse")
    assert r.returncode == 0, r.stderr
    first, second = r.stdout.splitlines()[:2]
    assert first == "OK greenhouse-caretaker"
    ir = json.loads(second)
    assert ir["recovery"]["on"] == "verify_effect_failed"


def test_validate_rejects_invalid_harness(tmp_path):
    (tmp_path / "agent.yml").write_text("spec: counterbalance-contract/v0.1\nname: x\nstate: {}\ntools: []\n", encoding="utf-8")
    r = cli("validate", str(tmp_path))
    assert r.returncode == 1 and r.stderr.strip()
    r2 = cli("validate", str(tmp_path / "agent.yml"))  # plain files are not harness refs (TS)
    assert r2.returncode == 1 and "expected harness directory" in r2.stderr


def test_replay_accepts_fixture_root(tmp_path):
    root = tmp_path / "fx"
    shutil.copytree(ROOT / "conformance" / "fixtures" / "allow-set-fan", root / "allow-set-fan")
    r = cli("replay", str(root), "--dump-dir", str(tmp_path / "dump"))
    assert r.returncode == 0 and r.stdout.strip() == "PASS allow-set-fan"
    assert (tmp_path / "dump" / "allow-set-fan.jsonl").read_text(encoding="utf-8") == (
        root / "allow-set-fan" / "expected.jsonl"
    ).read_text(encoding="utf-8")
    empty = tmp_path / "empty"
    empty.mkdir()
    r2 = cli("replay", str(empty))
    assert r2.returncode == 1 and "No fixtures found" in r2.stderr


def test_audit_matches_ts_summary(tmp_path):
    events = [
        {"stage": "validate", "verdict": "deny", "reason": "capability_missing", "tool": "x"},
        {"stage": "propose", "tool": "x"},
        {"stage": "validate", "verdict": "deny", "reason": "capability_missing", "tool": "x"},
        {"stage": "authorize", "verdict": "deny", "reason": "sequence_requirement_failed", "failure": {"kind": "missing_prior_tools"}},
        {"stage": "record", "reason": "memory_stale"},
    ]
    p = tmp_path / "e.jsonl"
    p.write_text("\r\n".join(json.dumps(e) for e in events) + "\n", encoding="utf-8")
    r = cli("audit", str(p), "--json")
    assert r.returncode == 0, r.stderr
    s = json.loads(r.stdout)
    assert s["near_misses"] == 1 and s["denies"] == 3 and s["memory_stale"] == 1
    assert s["structured_failures"] == {"missing_prior_tools": 1}
    assert r.stdout.strip() == json.dumps(s, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    human = cli("audit", str(p))
    assert "near_misses: 1" in human.stdout and "by_reason:" in human.stdout


def test_run_apply_overlays_and_stdout_like_ts(tmp_path):
    h = tmp_path / "h"
    h.mkdir()
    (h / "agent.yml").write_text(
        "spec: counterbalance-contract/v0.1\nname: ov\nstate: {}\n"
        "tools:\n  - id: fs.read\n  - id: fs.write_scoped\n"
        "overlays:\n  - when_model: kit.small\n    tools: [fs.read]\n",
        encoding="utf-8",
    )
    (h / "deployment.fixture.yml").write_text(
        "model: {transport: recorded, model: kit.small}\nbindings:\n  fs.read: {native: stub.fs_read}\n  fs.write_scoped: {native: stub.fs_write}\n",
        encoding="utf-8",
    )
    (h / "m.jsonl").write_text('{"type":"tool","name":"fs.write_scoped","args":{"path":"src/a.ts","content":"x"}}\n', encoding="utf-8")
    plain = cli("run", str(h), "--model", str(h / "m.jsonl"))
    assert plain.returncode == 0, plain.stderr
    assert '"stage":"execute"' in plain.stdout and plain.stdout.endswith("\n\n")
    over = cli("run", str(h), "--model", str(h / "m.jsonl"), "--apply-overlays")
    assert over.returncode == 0, over.stderr
    assert "overlay: matched kit.small" in over.stderr
    assert '"reason":"capability_missing"' in over.stdout


def test_repo_root_does_not_depend_on_package_depth(tmp_path):
    from fausth import cli as cli_mod

    assert cli_mod.repo_root() == ROOT.resolve()
    os.environ["FAUSTH_REPO_ROOT"] = str(tmp_path)
    try:
        assert cli_mod.repo_root() == tmp_path.resolve()
    finally:
        del os.environ["FAUSTH_REPO_ROOT"]


# --- verify: trust flags and exit codes (edge TS verifyBundleFile contract) ----------


def _signed_and_unsigned(tmp_path):
    from fausth.bundle_signature import generate_ed25519_seed_hex

    key = generate_ed25519_seed_hex()
    seed = tmp_path / "seed.hex"
    seed.write_text(key["seed_hex"], encoding="utf-8")
    harness = ROOT / "examples" / "greenhouse"
    unsigned = tmp_path / "u.fausth.json"
    signed = tmp_path / "s.fausth.json"
    assert cli("pack", str(harness), "--out", str(unsigned)).returncode == 0
    assert cli("pack", str(harness), "--out", str(signed), "--sign-key", str(seed)).returncode == 0
    trusted = tmp_path / "trusted.keys"
    trusted.write_text(f"# fausth trusted keys\n{key['public_key']}  release\n", encoding="utf-8")
    other = tmp_path / "other.keys"
    other.write_text(f"{generate_ed25519_seed_hex()['public_key']}\n", encoding="utf-8")
    return unsigned, signed, trusted, other


def test_verify_exit_codes_and_flags(tmp_path):
    env = {"FAUSTH_TRUSTED_KEYS": "", "FAUSTH_REQUIRE_TRUSTED_BUNDLES": ""}
    unsigned, signed, trusted, other = _signed_and_unsigned(tmp_path)
    r = cli("verify", str(unsigned), env_extra=env)
    assert r.returncode == 0 and r.stdout.startswith("OK unsigned")
    r = cli("verify", str(signed), "--trusted-keys", str(trusted), env_extra=env)
    assert r.returncode == 0 and r.stdout.startswith("OK signed-trusted") and "key_label=release" in r.stdout
    r = cli("verify", str(signed), "--trusted-keys", str(other), env_extra=env)
    assert r.returncode == 0 and r.stdout.startswith("OK signed-untrusted")
    r = cli("verify", str(signed), "--trusted-keys", str(other), "--require-trusted", env_extra=env)
    assert r.returncode == 3 and r.stderr.startswith("REJECTED signed-untrusted")
    r = cli("verify", str(unsigned), "--trusted-keys", str(trusted), "--require-trusted", env_extra=env)
    assert r.returncode == 3 and r.stderr.startswith("REJECTED unsigned")
    r = cli("verify", str(signed), "--trusted-keys", str(tmp_path / "missing.keys"), env_extra=env)
    assert r.returncode == 2 and r.stderr.startswith("INVALID bundle_trust_store_invalid")
    data = json.loads(signed.read_text(encoding="utf-8"))
    data["name"] = "tampered"
    tampered = tmp_path / "t.fausth.json"
    tampered.write_text(json.dumps(data), encoding="utf-8")
    r = cli("verify", str(tampered), "--trusted-keys", str(trusted), env_extra=env)
    assert r.returncode == 1 and r.stderr.startswith("INVALID")


def test_allow_command_flag_maps_to_env():
    import argparse

    from fausth import cli as cli_mod

    saved = os.environ.pop("FAUSTH_ALLOW_COMMANDS", None)
    try:
        cli_mod._apply_trust_flags(argparse.Namespace(trusted_keys=None, require_trusted=False, allow_commands=["python3", "node"]))
        assert os.environ["FAUSTH_ALLOW_COMMANDS"] == "python3,node"
        cli_mod._apply_trust_flags(argparse.Namespace(trusted_keys=None, require_trusted=False, allow_commands=["*"]))
        assert os.environ["FAUSTH_ALLOW_COMMANDS"] == "*"
    finally:
        os.environ.pop("FAUSTH_ALLOW_COMMANDS", None)
        if saved is not None:
            os.environ["FAUSTH_ALLOW_COMMANDS"] = saved
