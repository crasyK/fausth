"""Overlays (M18) — narrow-only, D5-correct (PY-18 overlays.py:31)."""
import pytest

from fausth.overlays import OverlayError, resolve_overlay

BASE = {
    "spec": "counterbalance-contract/v0.1",
    "name": "overlay-demo",
    "state": {},
    "tools": [{"id": "fs.read"}, {"id": "fs.write_scoped"}],
    "permissions": {"tools": ["fs.read", "fs.write_scoped"]},
    "limits": {"max_steps": 30},
    "overlays": [{"when_model": "kit.small", "tools": ["fs.read"], "limits": {"max_steps": 10}}],
}


def dep(model):
    return {"model": {"model": model}, "bindings": {}}


def test_narrows_tools_and_limits_for_matching_model():
    r = resolve_overlay(BASE, dep("kit.small"))
    assert r["reason"] == "matched kit.small"
    assert r["agent"]["permissions"]["tools"] == ["fs.read"]
    assert r["agent"]["limits"]["max_steps"] == 10
    assert [t["id"] for t in r["agent"]["tools"]] == ["fs.read"]
    assert "overlays" not in r["agent"]


def test_rejects_widening_tools_and_limits():
    bad = {**BASE, "overlays": [{"when_model": "kit.small", "tools": ["fs.read", "shell.run_allowlisted"]}]}
    with pytest.raises(OverlayError, match="widens tools"):
        resolve_overlay(bad, dep("kit.small"))
    bad2 = {**BASE, "overlays": [{"when_model": "kit.small", "limits": {"max_steps": 31}}]}
    with pytest.raises(OverlayError, match="widens limits.max_steps"):
        resolve_overlay(bad2, dep("kit.small"))


def test_empty_permissions_cannot_be_widened_by_overlay():
    # D5: permissions.tools [] permits nothing; an overlay must not re-grant declared tools.
    base = {**BASE, "permissions": {"tools": []}}
    with pytest.raises(OverlayError, match="widens tools"):
        resolve_overlay(base, dep("kit.small"))


def test_falls_back_and_model_id_rules():
    assert resolve_overlay(BASE, dep("other"))["reason"] == "no overlay for model other"
    assert resolve_overlay(BASE, {"model": {"model": ""}})["reason"] == "no deployment model id"
    assert resolve_overlay(BASE, {"model": {"models": ["kit.small"]}})["reason"] == "matched kit.small"
    no = {k: v for k, v in BASE.items() if k != "overlays"}
    assert resolve_overlay(no, dep("kit.small"))["reason"] == "no overlays"


def test_empty_limits_overlay_materializes_limits_like_ts():
    base = {k: v for k, v in BASE.items() if k != "limits"}
    base["overlays"] = [{"when_model": "kit.small", "limits": {}}]
    assert resolve_overlay(base, dep("kit.small"))["agent"]["limits"] == {}
