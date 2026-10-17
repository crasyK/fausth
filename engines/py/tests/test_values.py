import json
from pathlib import Path

import pytest

from fausth.values import canonical, excerpt, hash, parse_json

VECTORS = json.loads((Path(__file__).resolve().parents[3] / "conformance" / "values.json").read_text("utf-8"))


@pytest.mark.parametrize("case", VECTORS["canonical"], ids=lambda c: c["name"])
def test_canonical(case):
    if case.get("error"):
        with pytest.raises(ValueError):
            canonical(parse_json(case["json"]))
        return
    value = parse_json(case["json"])
    assert canonical(value) == case["canonical"]
    if "hash" in case:
        assert hash(value) == case["hash"]


@pytest.mark.parametrize("case", VECTORS["excerpt"], ids=lambda c: f"{c['s']!r}-{c['n']}")
def test_excerpt(case):
    assert excerpt(case["s"], case["n"]) == case["out"]


@pytest.mark.parametrize("value", [(1, 2), {1: 2}, float("nan"), float("inf"), 10**400, object()])
def test_canonical_rejects_values_that_are_not_json(value):
    with pytest.raises(ValueError):
        canonical(value)
