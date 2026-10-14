import math

import pytest

from fausth.canonical import (
    INT53_MAX,
    UNDEFINED,
    canonical_json,
    combine_surrogates,
    deep_eq,
    js_keys,
    js_number,
    js_number_to_string,
    js_string,
    js_trim,
    js_truthy,
    json_loads,
    read_jsonl,
    split_jsonl_lines,
    state_hash,
)
from fausth.predicates import MISSING, eval_predicate, get_path, is_missing


def test_canonical_sorts_keys():
    assert canonical_json({"b": 1, "a": 2}) == '{"a":2,"b":1}'


def test_int53_reject():
    with pytest.raises(ValueError):
        canonical_json({"x": INT53_MAX + 1})


def test_deep_eq_key_order():
    assert deep_eq({"a": 1, "b": 2}, {"b": 2, "a": 1})


def test_state_hash_stable():
    assert state_hash({"fan_percent": 0, "sensor_healthy": 1}) == state_hash(
        {"sensor_healthy": 1, "fan_percent": 0}
    )


def test_missing_sentinel():
    snap = {"action": {"name": "t", "args": {"percent": 40}}, "state": {}}
    assert get_path(snap, "action.args.missing") is MISSING
    assert is_missing(get_path(snap, "action.args.missing"))
    assert eval_predicate({"path": "action.args.missing", "eq": 1}, snap) is False
    assert eval_predicate({"path": "action.args.missing", "neq": 1}, snap) is False
    assert eval_predicate({"path": "action.args.a", "eq_path": "action.args.b"}, snap) is True


# --- D1: keys sort by Unicode code point -------------------------------------


def test_astral_keys_sort_by_code_point_not_utf16():
    # U+FF01 < U+1F600 by code point; UTF-16 order would put the emoji first.
    assert canonical_json({"\U0001F600": 2, "！": 1}) == '{"！":1,"😀":2}'


def test_integer_like_keys_sort_lexicographically():
    # JS objects would iterate "9" before "10"; canonical order is code point order.
    assert canonical_json({"9": 1, "10": 2, "a": 3}) == '{"10":2,"9":1,"a":3}'


def test_surrogate_pairs_are_joined_and_lone_surrogates_rejected():
    assert canonical_json({"k": "😀"}) == '{"k":"😀"}'
    assert combine_surrogates("😀") == "\U0001F600"
    # spec-v0.3 §1: strings must be well-formed Unicode; TS canonicalJson throws the same text.
    with pytest.raises(ValueError, match=r"Non-canonical value at \$\.k: string is not well-formed Unicode"):
        canonical_json({"k": "x\ud83d"})


def test_crlf_and_control_characters_escape_like_json_stringify():
    assert canonical_json("a\r\nb\t\x01\x7f ") == '"a\\r\\nb\\t\\u0001\x7f "'


def test_nested_nulls_kept():
    assert canonical_json({"a": None, "b": [None, {"c": None}]}) == '{"a":null,"b":[null,{"c":null}]}'


# --- D3: integral numbers are integers ----------------------------------------


@pytest.mark.parametrize("value,expected", [(1.0, "1"), (1e3, "1000"), (-0.0, "0"), (2.0**52, "4503599627370496")])
def test_integral_floats_encode_as_integers(value, expected):
    assert canonical_json(value) == expected
    assert canonical_json({"x": value}) == '{"x":%s}' % expected


@pytest.mark.parametrize("value", [1.5, math.nan, math.inf, -math.inf, 2.0**53])
def test_non_canonical_numbers_rejected(value):
    with pytest.raises(ValueError):
        canonical_json({"x": value})


def test_json_loads_normalizes_integral_numbers_and_rejects_constants():
    v = json_loads('{"a": 1.0, "b": 1e3, "c": 1.5, "d": -0.0, "e": 12}')
    assert v == {"a": 1, "b": 1000, "c": 1.5, "d": 0, "e": 12}
    assert all(type(v[k]) is int for k in "abde")
    for bad in ("NaN", "[Infinity]", '{"x": -Infinity}'):
        with pytest.raises(ValueError):
            json_loads(bad)
    assert deep_eq(json_loads("1.0"), 1)


def test_undefined_is_not_serializable_like_ts():
    with pytest.raises(ValueError, match=r"Unsupported type at \$.x: undefined"):
        canonical_json({"x": UNDEFINED})
    assert deep_eq(UNDEFINED, UNDEFINED) is False


# --- JS coercions -------------------------------------------------------------


@pytest.mark.parametrize(
    "value,expected",
    [
        (1e21, "1e+21"),
        (1e-7, "1e-7"),
        (0.000001, "0.000001"),
        (123456789012345680000.0, "123456789012345680000"),
        (-1.5e-3, "-0.0015"),
        (100.0, "100"),
        (math.nan, "NaN"),
        (-math.inf, "-Infinity"),
    ],
)
def test_js_number_to_string(value, expected):
    assert js_number_to_string(value) == expected


def test_js_string_and_number():
    assert js_string([1, None, [2, 3], "x", True]) == "1,,2,3,x,true"
    assert js_string({}) == "[object Object]"
    assert js_string(None) == "null" and js_string(UNDEFINED) == "undefined"
    assert js_number("  12 ") == 12 and js_number("0x1F") == 31 and js_number("") == 0
    assert math.isnan(js_number("1_000")) and math.isnan(js_number("١٢")) and math.isnan(js_number({}))
    assert js_number(None) == 0 and js_number(True) == 1 and js_number([5]) == 5


def test_js_truthiness_and_trim():
    assert js_truthy([]) and js_truthy({}) and js_truthy("0")
    assert not js_truthy("") and not js_truthy(0) and not js_truthy(None) and not js_truthy(math.nan)
    assert js_trim("﻿ x  ") == "x"
    assert js_trim("\x1cx") == "\x1cx"  # not JS whitespace


def test_js_keys_order():
    assert js_keys({"x": 1, "5": 2, "10": 3, "01": 4}) == ["5", "10", "x", "01"]


def test_jsonl_split_matches_ts_readjsonl(tmp_path):
    # Only \r?\n separates lines; U+2028 inside a JSON string is not a separator.
    text = '{"a":"x y"}\r\n\n  \n{"b":1.0}\n'
    assert split_jsonl_lines(text) == ['{"a":"x y"}', '{"b":1.0}']
    p = tmp_path / "m.jsonl"
    p.write_bytes(text.encode("utf-8"))
    assert read_jsonl(p) == [{"a": "x y"}, {"b": 1}]


# --- D16: predicate paths are own keys of JSON objects only -------------------


def test_predicate_paths_do_not_reach_array_members_or_prototype_names():
    snap = {"result": {"entries": ["a", "b"], "obj": {}}, "state": {"n": 1.0}}
    assert get_path(snap, "result.entries.length") is MISSING
    assert get_path(snap, "result.entries.0") is MISSING
    assert get_path(snap, "result.obj.constructor") is MISSING
    assert get_path(snap, "result.obj.__proto__") is MISSING
    assert eval_predicate({"path": "result.entries.length", "eq": 2}, snap) is False
    assert eval_predicate({"path": "result.entries.length", "gte": 0}, snap) is False


def test_numeric_predicates_accept_integral_values():
    snap = {"state": {"n": 1.0, "f": 1.5, "b": True}}
    assert eval_predicate({"path": "state.n", "lte": 1}, snap) is True
    assert eval_predicate({"path": "state.f", "lte": 2}, snap) is False  # non-integers never compare
    assert eval_predicate({"path": "state.b", "gte": 0}, snap) is False  # booleans are not numbers
    assert eval_predicate({"path": "state.n", "eq": 1}, snap) is True
