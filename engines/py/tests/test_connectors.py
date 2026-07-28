from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from fausth.connectors import ConnectorError, resolve_harness, resolved_harness_canonical_json
from fausth.packaging import inspect_harness

ROOT = Path(__file__).resolve().parents[3]
EXAMPLE = ROOT / "examples" / "primitives" / "inline-file-connectors"
CODING = ROOT / "examples" / "coding-counterbalance"


def test_identity_resolve_legacy():
    resolved = resolve_harness(CODING)
    assert resolved["format"] == "fausth-resolved-harness/v0.1"
    assert resolved["agent"]["name"] == "coding-counterbalance-slice"
    assert resolved["resolution"]["connectors"] == []
    assert resolved["resolution"]["selected"] == []
    assert resolved["resolution"]["lock"] == []
    again = resolve_harness(CODING)
    assert resolved_harness_canonical_json(resolved) == resolved_harness_canonical_json(again)


def test_inline_file_resolve():
    resolved = resolve_harness(EXAMPLE)
    assert len(resolved["resolution"]["connectors"]) == 2
    assert resolved["resolution"]["selected"] == ["echo.ping", "greet.say"]
    tool_ids = sorted(t["id"] for t in resolved["agent"]["tools"])
    assert tool_ids == ["echo.ping", "greet.say", "ping.local"]
    file_lock = next(x for x in resolved["resolution"]["lock"] if x["kind"] == "file")
    text = (EXAMPLE / "connectors" / "echo.yml").read_text(encoding="utf-8")
    assert file_lock["sha256"] == hashlib.sha256(text.encode("utf-8")).hexdigest()


def test_hash_mismatch(tmp_path: Path):
    (tmp_path / "agent.yml").write_text(
        "spec: counterbalance-contract/v0.1\nname: t\nstate: {}\ntools:\n  - id: ping.local\n",
        encoding="utf-8",
    )
    (tmp_path / "connectors").mkdir()
    (tmp_path / "connectors" / "echo.yml").write_text(
        "format: fausth-connector-manifest/v0.1\nprovides:\n  - id: echo.ping\n",
        encoding="utf-8",
    )
    (tmp_path / "connectors.yml").write_text(
        "format: fausth-connectors/v0.1\nconnectors:\n"
        "  - id: echo\n    kind: file\n    path: connectors/echo.yml\n"
        f'    sha256: "{"0" * 64}"\n',
        encoding="utf-8",
    )
    with pytest.raises(ConnectorError) as ei:
        resolve_harness(tmp_path)
    assert ei.value.code == "connectors_hash_mismatch"


def test_unknown_select_and_path_traversal(tmp_path: Path):
    (tmp_path / "agent.yml").write_text(
        "spec: counterbalance-contract/v0.1\nname: t\nstate: {}\ntools:\n  - id: ping.local\n",
        encoding="utf-8",
    )
    (tmp_path / "connectors.yml").write_text(
        "format: fausth-connectors/v0.1\nconnectors:\n"
        "  - id: greet\n    kind: inline\n    provides:\n      - id: greet.say\n"
        "    select: [missing.tool]\n",
        encoding="utf-8",
    )
    with pytest.raises(ConnectorError) as ei:
        resolve_harness(tmp_path)
    assert ei.value.code == "connectors_unknown_select"

    (tmp_path / "connectors.yml").write_text(
        "format: fausth-connectors/v0.1\nconnectors:\n"
        "  - id: escape\n    kind: file\n    path: ../outside.yml\n",
        encoding="utf-8",
    )
    with pytest.raises(ConnectorError) as ei2:
        resolve_harness(tmp_path)
    assert ei2.value.code == "connectors_path"


def test_inspect_resolution():
    report = inspect_harness(str(EXAMPLE))
    assert report["resolution"]["ok"] is True
    assert report["resolution"]["connector_count"] == 2
    assert report["resolution"]["kinds"] == ["file", "inline"]
    legacy = inspect_harness(str(CODING))
    assert legacy["resolution"]["ok"] is True
    assert legacy["resolution"]["connector_count"] == 0
