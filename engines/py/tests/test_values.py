import json
from pathlib import Path

import pytest

from fausth.values import argument_text, canonical, excerpt, hash, parse_json, sorted_ascii_text

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


@pytest.mark.parametrize("case", VECTORS["argument_text"], ids=lambda c: c["name"])
def test_argument_text(case):
    value = parse_json(case["json"])
    assert argument_text(value) == case["text"]
    assert argument_text(value, True) == case["indented"]


@pytest.mark.parametrize("case", VECTORS["sorted_ascii"], ids=lambda c: c["name"])
def test_sorted_ascii(case):
    assert sorted_ascii_text(case["raw"]) == case["text"]
    assert sorted_ascii_text(case["raw"], True) == case["indented"]


@pytest.mark.parametrize("raw", ["NaN", "[Infinity]", "1e400", '"\\ud800"', "{", "", "[1,]"])
def test_sorted_ascii_needs_json_text_with_a_canonical_form(raw):
    with pytest.raises(ValueError):
        sorted_ascii_text(raw)


def test_the_argument_text_needs_a_canonical_form():
    with pytest.raises(ValueError):
        argument_text(parse_json('"\\ud800"'))
    with pytest.raises(ValueError):
        argument_text(float("nan"))


@pytest.mark.parametrize("value", [(1, 2), {1: 2}, float("nan"), float("inf"), 10**400, object()])
def test_canonical_rejects_values_that_are_not_json(value):
    with pytest.raises(ValueError):
        canonical(value)
