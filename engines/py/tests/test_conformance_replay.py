"""The Python engine replays every spec-derived conformance fixture byte-identically (spec-v0.3).

The goldens are produced by the normative TS replay host from docs/spec-v0.3.md; this test is the
Python half of the TS↔PY parity claim and supersedes the phase-1 shape tests it replaced.
"""

from pathlib import Path

import pytest

from fausth.runtime import replay_fixture

FIXTURES = Path(__file__).resolve().parents[3] / "conformance" / "fixtures"


@pytest.mark.parametrize("fixture", sorted(p.name for p in FIXTURES.iterdir() if (p / "expected.jsonl").exists()))
def test_fixture_replays_byte_identically(fixture: str) -> None:
    ok, actual, expected = replay_fixture(FIXTURES / fixture)
    assert ok, f"{fixture}\n--- actual ---\n{actual}\n--- expected ---\n{expected}"
