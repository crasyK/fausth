"""§8.1: why arguments fail (the cases the conformance fixture leaves out)."""
from fausth.schema import argument_reasons

S = {"type": "object", "properties": {"n": {"type": "integer"}, "e": {"enum": [1, "a"]}, "s": {"type": "string", "minLength": 2}}}


def test_booleans_are_not_numbers_and_enum_compares_canonical_forms():
    assert argument_reasons(S, {"n": True}) == "n: must be an integer"
    assert argument_reasons(S, {"e": True}) == 'e: must be one of 1, "a"'
    assert argument_reasons(S, {"e": 1.0, "n": 2.0}) == "does not match the input schema"  # both fine: no reason


def test_code_points_and_no_schema():
    assert argument_reasons(S, {"s": "\U0001F642"}) == "s: at least 2 characters (it has 1)"
    assert argument_reasons(True, {}) == "does not match the input schema"
