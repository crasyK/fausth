from pathlib import Path

import pytest

from fausth.harness import harness_errors, read_harness
from fausth.values import canonical

ROOT = Path(__file__).resolve().parents[3]
DIR = ROOT / "conformance" / "harnesses"


def files(sub):
    return sorted(p.name for p in (DIR / sub).iterdir() if not p.name.endswith(".expected"))


def load(text):
    """Read and check a harness the way an engine loads it; raises with the reasons if it is invalid."""
    value = read_harness(text)
    canonical(value)
    errors = harness_errors(value)
    if errors:
        raise ValueError("; ".join(errors))
    return value


@pytest.mark.parametrize("name", files("valid"))
def test_valid(name):
    value = load((DIR / "valid" / name).read_text("utf-8"))
    assert canonical(value) == (DIR / "valid" / f"{name}.expected").read_text("utf-8").rstrip()


@pytest.mark.parametrize("name", files("invalid"))
def test_invalid(name):
    with pytest.raises(ValueError):
        load((DIR / "invalid" / name).read_text("utf-8"))


def test_packaged_schema_is_the_repo_schema():
    packaged = Path(__file__).resolve().parents[1] / "fausth" / "harness.v0.5.json"
    assert packaged.read_bytes() == (ROOT / "schema" / "harness.v0.5.json").read_bytes()
