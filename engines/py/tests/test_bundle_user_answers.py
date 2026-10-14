"""Bundles carry recorded user-channel answers (D14, spec-v0.3 §15.2) — mirrors TS bundle.test.ts."""
from __future__ import annotations

from pathlib import Path

import pytest

from fausth.bundle import (
    BUNDLE_FORMAT_V01,
    BUNDLE_FORMAT_V02,
    BUNDLE_FORMAT_V03,
    BundleError,
    assert_safe_bundle_entry_name,
    load_bundle_file,
)
from fausth.packaging import pack_harness

ROOT = Path(__file__).resolve().parents[3]


@pytest.mark.parametrize("fmt", [BUNDLE_FORMAT_V01, BUNDLE_FORMAT_V02, BUNDLE_FORMAT_V03])
def test_allowlist_admits_user_answers_only(fmt):
    assert_safe_bundle_entry_name("user.answers.jsonl", fmt)
    for bad in ("user.answers.json", "answers.jsonl", "user.answers.jsonl.bak", "x/user.answers.jsonl", "user.answers.jsonl\n"):
        with pytest.raises(BundleError):
            assert_safe_bundle_entry_name(bad, fmt)


def test_pack_includes_recorded_user_answers(tmp_path):
    src = ROOT / "examples" / "support-bot-ask"
    r = pack_harness(str(src), str(tmp_path / "ask.fausth.json"))
    assert "user.answers.jsonl" in r["files"]
    bundle = load_bundle_file(r["out"])
    assert bundle["files"]["user.answers.jsonl"] == (src / "user.answers.jsonl").read_bytes().decode("utf-8")
