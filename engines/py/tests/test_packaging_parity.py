"""Python packaging mirrors TS inspect/test semantics (integrator follow-up 5)."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

import fausth.packaging as packaging
from fausth.registry import ToolSet

ROOT = Path(__file__).resolve().parents[3]


def test_inspect_omits_undefined_optional_keys_and_reports_mutable():
    gh = packaging.inspect_harness(str(ROOT / "examples" / "greenhouse"))
    for key in ("spawn", "sequences", "mutable"):
        assert key not in gh, key  # undefined in the IR → omitted, never null
    ms = packaging.inspect_harness(str(ROOT / "examples" / "mutable-skills"))
    assert ms.get("mutable"), "mutable cells are reported like TS"
    assert None not in ms.values()


def test_inspect_extracts_missing_binding(tmp_path):
    h = tmp_path / "h"
    shutil.copytree(ROOT / "examples" / "greenhouse", h)
    dep = (h / "deployment.fixture.yml").read_text(encoding="utf-8")
    lines = [ln for ln in dep.splitlines() if "system.wait" not in ln and "stub.wait" not in ln]
    (h / "deployment.fixture.yml").write_text("\n".join(lines) + "\n", encoding="utf-8")
    cov = packaging.inspect_harness(str(h))["binding_coverage"]
    assert cov["ok"] is False
    assert cov["missing"] == ["system.wait"]


def test_test_harness_validates_the_agent_first(tmp_path):
    h = tmp_path / "h"
    shutil.copytree(ROOT / "examples" / "greenhouse", h)
    agent = (h / "agent.yml").read_text(encoding="utf-8")
    assert "max_steps: 6" in agent
    (h / "agent.yml").write_text(agent.replace("max_steps: 6", "max_steps: 1.5"), encoding="utf-8")
    r = packaging.test_harness(str(h), skip_fixtures=True)
    assert r["ok"] is False
    assert r["validate_ok"] is False
    assert r["bindings_ok"] is False and r["smoke_ok"] is None


def test_test_harness_reports_unparseable_agents_instead_of_raising(tmp_path):
    h = tmp_path / "h"
    shutil.copytree(ROOT / "examples" / "greenhouse", h)
    agent = (h / "agent.yml").read_text(encoding="utf-8")
    (h / "agent.yml").write_text(agent + "\nlimits:\n  max_steps: 2\n", encoding="utf-8")  # duplicate key
    r = packaging.test_harness(str(h), skip_fixtures=True)
    assert r["ok"] is False and r["validate_ok"] is False
    assert r["errors"]


def test_test_harness_closes_tool_sets_and_passes_deployment_path(monkeypatch):
    seen: list[dict] = []
    real = packaging.resolve_tools_from_deployment

    sets: list = []

    class TrackedToolSet(ToolSet):
        was_closed = False

        def close(self) -> None:  # type: ignore[override]
            self.was_closed = True
            super().close()

    def tracking(*args, **kwargs):
        seen.append(kwargs)
        ts = real(*args, **kwargs)
        tracked = TrackedToolSet(dict(ts), [ts.close], user_tools=ts.user_tools)
        sets.append(tracked)
        return tracked

    monkeypatch.setattr(packaging, "resolve_tools_from_deployment", tracking)
    r = packaging.test_harness(str(ROOT / "examples" / "support-bot"), skip_fixtures=True)
    assert r["validate_ok"] is True and r["bindings_ok"] is True
    assert seen and all(str(k.get("deployment_path", "")).endswith("deployment.fixture.yml") for k in seen)
    # binding check + smoke run each bind once, and every tool set is closed by test_harness
    assert len(seen) == 2
    assert all(t.was_closed for t in sets)
