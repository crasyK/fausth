from pathlib import Path

import pytest

from fausth.replay import replay

# Every conformance fixture must replay to both expected files byte for byte (spec §14).
ROOT = Path(__file__).resolve().parents[3] / "conformance" / "fixtures"


@pytest.mark.parametrize("name", sorted(p.name for p in ROOT.iterdir()))
def test_fixture(name):
    log, requests = replay(ROOT / name)
    assert log == (ROOT / name / "expected.log.jsonl").read_text("utf-8")
    assert requests == (ROOT / name / "expected.requests.jsonl").read_text("utf-8")
