"""Bundle trust store, re-resolution, pack/load consistency and selection (Python engine).

Mirrors engines/ts/src/bundle.test.ts + packaging.test.ts so both hosts give the same
answers for the same bundle.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path

import pytest

from fausth.bundle import (
    BUNDLE_FORMAT_V02,
    BUNDLE_FORMAT_V03,
    BundleError,
    assert_safe_bundle_entry_name,
    format_bundle_verify_report,
    load_bundle_file,
    load_verified_bundle_file,
    resolve_harness_ref,
    unpack_bundle,
    validate_bundle,
    verify_bundle_file,
)
from fausth.bundle_signature import (
    REQUIRE_TRUSTED_ENV,
    TRUSTED_KEYS_ENV,
    BundleSignatureError,
    generate_ed25519_seed_hex,
    parse_trust_store,
    sign_bundle,
)
from fausth.connectors import ConnectorError, resolve_harness, resolved_harness_hash
from fausth.packaging import (
    evaluate_fixture_fitness,
    pack_harness,
    security_cell_changes,
    select_harness,
)
from fausth.packaging import test_harness as run_harness_test
from fausth.provenance import bundle_provenance_for

ROOT = Path(__file__).resolve().parents[3]
CONNECTORS = ROOT / "examples" / "primitives" / "inline-file-connectors"
MODULES = ROOT / "examples" / "primitives" / "module-connectors"
FIXTURES = ROOT / "conformance" / "fixtures"
MUTABLE = ROOT / "examples" / "mutable-skills"


@pytest.fixture(autouse=True)
def _clean_trust_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(TRUSTED_KEYS_ENV, raising=False)
    monkeypatch.delenv(REQUIRE_TRUSTED_ENV, raising=False)


def _pack_signed(tmp: Path, harness: Path = CONNECTORS) -> tuple[str, str]:
    keys = generate_ed25519_seed_hex()
    seed = tmp / f"seed-{keys['public_key'][:8]}.hex"
    seed.write_text(keys["seed_hex"] + "\n", encoding="utf-8")
    r = pack_harness(str(harness), str(tmp / f"signed-{keys['public_key'][:8]}.fausth.json"), sign_key=str(seed))
    return r["out"], keys["public_key"]


# --- EDGE-1: trust store + three outcomes --------------------------------------------


def test_parse_trust_store_strict() -> None:
    a = "ab" * 32
    b = "CD" * 32
    store = parse_trust_store(f"﻿# release keys\r\n{a} release-2026\r\n\r\n{b}\n", "keys.txt")
    assert set(store["keys"]) == {a, "cd" * 32}
    assert store["keys"][a]["label"] == "release-2026"
    assert "label" not in store["keys"]["cd" * 32]
    with pytest.raises(BundleSignatureError) as ei:
        parse_trust_store(f"{a}\nnot-a-key\n")
    assert ei.value.code == "bundle_trust_store_invalid"
    with pytest.raises(BundleSignatureError):
        parse_trust_store("ab" * 31 + "\n")


def test_verify_reports_three_outcomes_tamper_and_policy(tmp_path: Path) -> None:
    unsigned = pack_harness(str(CONNECTORS), str(tmp_path / "u.fausth.json"))["out"]
    signed, public_key = _pack_signed(tmp_path)
    other = generate_ed25519_seed_hex()["public_key"]
    trusted = tmp_path / "trusted.keys"
    trusted.write_text(f"# ops\n{public_key} release-2026\n", encoding="utf-8")
    untrusted = tmp_path / "untrusted.keys"
    untrusted.write_text(f"{other} someone-else\n", encoding="utf-8")

    r1 = verify_bundle_file(unsigned, trusted_keys=str(trusted))
    assert (r1["status"], r1["exit_code"]) == ("unsigned", 0)
    assert format_bundle_verify_report(r1) == f"OK unsigned ({BUNDLE_FORMAT_V02})"

    r2 = verify_bundle_file(signed, trusted_keys=str(untrusted))
    assert (r2["status"], r2["exit_code"], r2["public_key"]) == ("signed-untrusted", 0, public_key)

    r3 = verify_bundle_file(signed, trusted_keys=str(trusted), require_trusted=True)
    assert (r3["status"], r3["exit_code"], r3["key_label"]) == ("signed-trusted", 0, "release-2026")
    assert format_bundle_verify_report(r3) == (
        f"OK signed-trusted ed25519 public_key={public_key} key_label=release-2026 ({BUNDLE_FORMAT_V02})"
    )

    r4 = verify_bundle_file(unsigned, trusted_keys=str(trusted), require_trusted=True)
    assert (r4["exit_code"], r4["error"]["code"]) == (3, "bundle_unsigned")
    assert format_bundle_verify_report(r4).startswith("REJECTED unsigned")

    r5 = verify_bundle_file(signed, trusted_keys=str(untrusted), require_trusted=True)
    assert (r5["exit_code"], r5["error"]["code"]) == (3, "bundle_signature_untrusted")

    raw = json.loads(Path(signed).read_text(encoding="utf-8"))
    raw["files"]["agent.yml"] += "\n# tampered\n"
    tampered = tmp_path / "tampered.fausth.json"
    tampered.write_text(json.dumps(raw) + "\n", encoding="utf-8")
    r6 = verify_bundle_file(tampered, trusted_keys=str(trusted))
    assert (r6["exit_code"], r6["error"]["code"]) == (1, "bundle_signature_invalid")
    assert format_bundle_verify_report(r6).startswith("INVALID bundle_signature_invalid")

    r7 = verify_bundle_file(signed, trusted_keys=str(tmp_path / "missing.keys"))
    assert (r7["exit_code"], r7["error"]["code"]) == (2, "bundle_trust_store_invalid")


def test_env_policy_enforced_at_load_and_unpack(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    unsigned = pack_harness(str(CONNECTORS), str(tmp_path / "u.fausth.json"))["out"]
    signed, public_key = _pack_signed(tmp_path)
    trusted = tmp_path / "trusted.keys"
    trusted.write_text(f"{public_key}\n", encoding="utf-8")

    monkeypatch.setenv(TRUSTED_KEYS_ENV, str(trusted))
    monkeypatch.setenv(REQUIRE_TRUSTED_ENV, "1")
    with pytest.raises(BundleError) as ei:
        load_bundle_file(unsigned)
    assert ei.value.code == "bundle_unsigned"
    with pytest.raises(BundleError):
        unpack_bundle(unsigned, tmp_path / "nope")
    assert not (tmp_path / "nope").exists()
    _, trust = load_verified_bundle_file(signed)
    assert trust["status"] == "signed-trusted"

    monkeypatch.delenv(TRUSTED_KEYS_ENV)
    with pytest.raises(BundleError) as ei2:
        load_bundle_file(signed)
    assert ei2.value.code == "bundle_signature_untrusted"

    monkeypatch.delenv(REQUIRE_TRUSTED_ENV)
    assert load_verified_bundle_file(signed)[1]["status"] == "signed-untrusted"
    assert load_verified_bundle_file(unsigned)[1]["status"] == "unsigned"


def test_resolve_harness_ref_registers_provenance(tmp_path: Path) -> None:
    signed, public_key = _pack_signed(tmp_path)
    trusted = tmp_path / "trusted.keys"
    trusted.write_text(f"{public_key} ci\n", encoding="utf-8")
    ref = resolve_harness_ref(signed, trusted_keys=str(trusted))
    harness_dir = ref.harness_dir
    try:
        assert ref.trust["status"] == "signed-trusted"
        prov = bundle_provenance_for(harness_dir / "deployment.fixture.yml")
        assert prov is not None
        assert (prov["trust"], prov["public_key"], prov["format"]) == (
            "signed-trusted",
            public_key,
            BUNDLE_FORMAT_V02,
        )
    finally:
        ref.cleanup()
    assert bundle_provenance_for(harness_dir) is None

    unsigned = pack_harness(str(CONNECTORS), str(tmp_path / "u.fausth.json"))["out"]
    uref = resolve_harness_ref(unsigned, trusted_keys=str(trusted))
    try:
        assert bundle_provenance_for(uref.harness_dir)["trust"] == "unsigned"
    finally:
        uref.cleanup()
    assert bundle_provenance_for(CONNECTORS) is None


def test_shape_rejections_are_bundle_errors(tmp_path: Path) -> None:
    out = pack_harness(str(CONNECTORS), str(tmp_path / "b.fausth.json"))["out"]
    raw = json.loads(Path(out).read_text(encoding="utf-8"))
    with pytest.raises(BundleError) as e_null:
        validate_bundle({**raw, "signature": None})
    assert e_null.value.code == "bundle_signature_invalid"
    with pytest.raises(BundleError) as e_top:
        validate_bundle({**raw, "smuggled": {"run": "this"}})
    assert e_top.value.code == "bundle_invalid"
    with_float = copy.deepcopy(raw)
    with_float["resolved"]["agent"]["state"]["threshold"] = 0.5
    with pytest.raises(BundleError) as e_float:
        validate_bundle(with_float)
    assert e_float.value.code == "bundle_invalid"
    # D3: integral floats are ints at the entry (TS JSON.parse does the same).
    integral = copy.deepcopy(raw)
    integral["resolved"]["agent"]["limits"]["max_steps"] = float(
        integral["resolved"]["agent"]["limits"]["max_steps"]
    )
    assert validate_bundle(integral)["resolved_sha256"] == raw["resolved_sha256"]
    with pytest.raises(BundleError) as e_long:
        validate_bundle({**raw, "files": {**raw["files"], "connectors/" + "a" * 200 + ".yml": "x"}})
    assert e_long.value.code == "bundle_path"


def test_entry_names_reject_trailing_newline() -> None:  # PY-19
    with pytest.raises(BundleError) as ei:
        assert_safe_bundle_entry_name("agent.yml\n")
    assert ei.value.code == "bundle_unknown_entry"
    with pytest.raises(BundleError):
        assert_safe_bundle_entry_name("connectors/wait.yml\n", BUNDLE_FORMAT_V02)
    with pytest.raises(BundleError):
        validate_bundle(
            {"format": "fausth-harness-bundle/v0.1", "name": "x\n", "files": {"agent.yml": "name: x\n"}}
        )


# --- EDGE-12: embedded resolved must match the shipped sources --------------------------


def test_forged_resolved_ir_rejected(tmp_path: Path) -> None:
    out = pack_harness(str(CONNECTORS), str(tmp_path / "b.fausth.json"))["out"]
    raw = json.loads(Path(out).read_text(encoding="utf-8"))
    perms = raw["resolved"]["agent"].setdefault("permissions", {})
    perms["tools"] = list(perms.get("tools") or []) + ["evil.exfiltrate"]
    raw["resolved_sha256"] = resolved_harness_hash(raw["resolved"])
    dest = tmp_path / "out"
    with pytest.raises(BundleError) as ei:
        unpack_bundle(raw, dest)
    assert ei.value.code == "bundle_resolved_mismatch"
    assert not dest.exists()

    seed = tmp_path / "seed.hex"
    seed.write_text(generate_ed25519_seed_hex()["seed_hex"], encoding="utf-8")
    forged = tmp_path / "forged.fausth.json"
    forged.write_text(json.dumps(sign_bundle(raw, seed)) + "\n", encoding="utf-8")
    report = verify_bundle_file(forged)
    assert (report["exit_code"], report["error"]["code"]) == (1, "bundle_resolved_mismatch")


# --- EDGE-11: v0.3 module packs round-trip; pack never emits rejected entries ------------


def test_module_connector_round_trip(tmp_path: Path) -> None:
    r = pack_harness(str(MODULES), str(tmp_path / "m.fausth.json"))
    assert r["format"] == BUNDLE_FORMAT_V03
    assert "connectors/module/echo.json" in r["files"]
    assert "module.recorded.jsonl" in r["files"]
    bundle = load_bundle_file(r["out"])
    assert any(lock["kind"] == "module" for lock in bundle["resolved"]["resolution"]["lock"])
    unpack_bundle(r["out"], tmp_path / "unpacked")
    assert (tmp_path / "unpacked" / "connectors" / "module" / "echo.json").is_file()
    ref = resolve_harness_ref(r["out"])
    try:
        assert resolved_harness_hash(resolve_harness(ref.harness_dir)) == bundle["resolved_sha256"]
    finally:
        ref.cleanup()


def test_module_bundle_smoke_runs_on_python_host(tmp_path: Path) -> None:
    r = pack_harness(str(MODULES), str(tmp_path / "m.fausth.json"))
    ref = resolve_harness_ref(r["out"])
    try:
        result = run_harness_test(
            str(ref.harness_dir),
            skip_fixtures=True,
            embedded_resolved=ref.embedded_resolved,
            bundle_format=ref.bundle_format,
        )
        assert result["ok"], result["errors"]
        assert result["smoke_ok"] is True
    finally:
        ref.cleanup()


def test_pack_skips_v03_only_extras_for_v02(tmp_path: Path) -> None:
    for name in ("agent.yml", "connectors.yml", "deployment.fixture.yml", "smoke.model.jsonl", "smoke.expected.jsonl"):
        src = CONNECTORS / name
        if src.is_file():
            (tmp_path / name).write_bytes(src.read_bytes())
    (tmp_path / "connectors").mkdir()
    (tmp_path / "connectors" / "wait.yml").write_bytes((CONNECTORS / "connectors" / "wait.yml").read_bytes())
    (tmp_path / "mcp.recorded.jsonl").write_text('{"tool":"x","result":{}}\n', encoding="utf-8")
    r = pack_harness(str(tmp_path), str(tmp_path / "dist" / "p.fausth.json"))
    assert r["format"] == BUNDLE_FORMAT_V02
    assert "mcp.recorded.jsonl" not in r["files"]
    assert load_bundle_file(r["out"])["format"] == BUNDLE_FORMAT_V02


# --- PY-13: raw bytes, CRLF preserved, strict UTF-8 -------------------------------------


def _crlf_harness(d: Path) -> str:
    (d / "agent.yml").write_bytes(
        b"spec: counterbalance-contract/v0.1\r\nname: crlf\r\nstate: {}\r\ntools:\r\n  - id: ping.local\r\n"
    )
    (d / "connectors").mkdir()
    manifest = 'format: fausth-connector-manifest/v0.1\r\nprovides:\r\n  - id: echo.ping\r\n    description: "crlf"\r\n'
    (d / "connectors" / "echo.yml").write_bytes(manifest.encode("utf-8"))
    (d / "connectors.yml").write_bytes(
        b"format: fausth-connectors/v0.1\r\nconnectors:\r\n  - id: echo\r\n    kind: file\r\n"
        b"    path: connectors/echo.yml\r\n"
    )
    return manifest


def test_crlf_bytes_pinned_and_packed(tmp_path: Path) -> None:
    manifest = _crlf_harness(tmp_path)
    resolved = resolve_harness(tmp_path)
    lock = next(x for x in resolved["resolution"]["lock"] if x["kind"] == "file")
    assert lock["sha256"] == hashlib.sha256(manifest.encode("utf-8")).hexdigest()
    r = pack_harness(str(tmp_path), str(tmp_path / "dist" / "c.fausth.json"))
    bundle = load_bundle_file(r["out"])
    assert bundle["files"]["connectors/echo.yml"] == manifest
    assert "\r\n" in bundle["files"]["agent.yml"]


def test_invalid_utf8_connector_rejected(tmp_path: Path) -> None:
    _crlf_harness(tmp_path)
    (tmp_path / "connectors" / "echo.yml").write_bytes(
        b"format: fausth-connector-manifest/v0.1\nprovides:\n  - id: echo.ping\n    description: caf\xe9\n"
    )
    with pytest.raises(ConnectorError) as ei:
        resolve_harness(tmp_path)
    assert ei.value.code == "connectors_invalid"


# --- PY-20: selection runs the candidate on recorded transcripts ------------------------


def test_select_runs_candidate_against_recorded_transcripts() -> None:
    patch = json.loads((MUTABLE / "patch-skills.json").read_text(encoding="utf-8"))
    r = select_harness(str(MUTABLE), patch, fixtures_root=str(FIXTURES))
    assert r["ok"], r["errors"]
    assert r["security_ok"] and r["fitness_evaluated"]
    assert len(r["fixtures"]) >= 3
    for f in r["fixtures"]:
        assert f["replayable"] and f["candidate_pass"] is True, f
        assert f["candidate"]["denies"] == f["baseline"]["denies"]
    tool = next(t for t in r["patched_agent"]["tools"] if t["id"] == "fs.read")
    assert tool["description"] == "Read a scoped source file carefully"

    skipped = select_harness(str(MUTABLE), patch, fixtures_root=str(FIXTURES), skip_fixtures=True)
    assert skipped["ok"] and not skipped["fitness_evaluated"]
    assert any("NOT fitness-tested" in d for d in skipped["details"])


def test_security_cell_changes_detected() -> None:
    before = json.loads((FIXTURES / "cb-harness-patch-skills-ok" / "agent.json").read_text(encoding="utf-8"))
    widened = copy.deepcopy(before)
    widened.setdefault("permissions", {})["tools"] = list(widened["permissions"].get("tools") or []) + ["shell.run"]
    assert security_cell_changes(before, widened) == ["security cell changed: permissions"]
    described = copy.deepcopy(before)
    described["tools"][0]["description"] = "new skill text"
    assert security_cell_changes(before, described) == []
    not_mutable = copy.deepcopy(before)
    not_mutable["mutable"] = []
    after = copy.deepcopy(not_mutable)
    after["instinct_text"] = "be bold"
    assert security_cell_changes(not_mutable, after) == [
        "cell not mutable: instincts (instinct_text changed)"
    ]


def test_candidate_losing_a_deny_is_rejected() -> None:
    d = FIXTURES / "deny-fan-over-80"
    baseline = json.loads((d / "agent.json").read_text(encoding="utf-8"))
    candidate = copy.deepcopy(baseline)
    candidate["gates"] = []
    f = evaluate_fixture_fitness(d, baseline, candidate)
    assert f["replayable"] is True
    assert f["candidate_pass"] is False
    assert any(r.startswith("lost 1× deny|authorize|actuator.fan.set|") for r in f["reasons"]), f["reasons"]
    same = evaluate_fixture_fitness(d, baseline, copy.deepcopy(baseline))
    assert same["candidate_pass"] is True


def test_env_cleanup_sanity() -> None:
    assert TRUSTED_KEYS_ENV not in os.environ
