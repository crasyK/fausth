"""PY-14: tool schema validation matches Ajv + ajv-formats (full mode) as used by TS."""
import pytest

from fausth import schema_validate
from fausth.schema_validate import FORMAT_NAMES, translate_js_regex, validate_against_schema


def ok(schema, data):
    return validate_against_schema(schema, data)[0]


def fmt(name, value):
    return ok({"properties": {"x": {"format": name}}}, {"x": value})


@pytest.mark.parametrize(
    "value,valid",
    [
        ("a@b.co", True),
        ("A@B.CO", True),
        ("user+tag@sub.example.org", True),
        ("a@b", False),
        ("a..b@c.de", False),
        ("a@b.co\n", False),  # JS `$` is end of input only
        ("é@b.co", False),
    ],
)
def test_email_format(value, valid):
    assert fmt("email", value) is valid


@pytest.mark.parametrize(
    "value,valid",
    [
        ("http://example.com/a?b#c", True),
        ("urn:isbn:0451450523", True),
        ("x.com", False),  # needs a scheme
        ("a b", False),
        ("http://x.com/ space", False),
    ],
)
def test_uri_format(value, valid):
    assert fmt("uri", value) is valid


@pytest.mark.parametrize(
    "value,valid",
    [
        ("2020-01-01T10:00:00Z", True),
        ("2020-01-01t10:00:00z", True),
        ("2020-01-01 10:00:00+05:30", True),
        ("2020-01-01T23:59:60Z", True),  # leap second
        ("2020-01-01T10:00:00", False),  # full mode requires a time zone
        ("2020-02-30T10:00:00Z", False),
        ("2020-01-01T10:00:00Z\n", False),
    ],
)
def test_date_time_format(value, valid):
    assert fmt("date-time", value) is valid


def test_all_ajv_full_formats_registered():
    for name in (
        "date", "time", "date-time", "iso-time", "iso-date-time", "duration", "uri", "uri-reference",
        "uri-template", "url", "email", "hostname", "ipv4", "ipv6", "regex", "uuid", "json-pointer",
        "json-pointer-uri-fragment", "relative-json-pointer", "byte", "int32", "int64", "float", "double",
        "password", "binary",
    ):
        assert name in FORMAT_NAMES


def test_number_formats_and_non_applicable_types():
    assert ok({"properties": {"x": {"type": "integer", "format": "int32"}}}, {"x": 2**31 - 1})
    assert not ok({"properties": {"x": {"type": "integer", "format": "int32"}}}, {"x": 2**31})
    # string formats ignore numbers, number formats ignore strings (ajv semantics)
    assert fmt("email", 5) and fmt("int32", "nope")
    assert fmt("unknown-format", "anything")


def test_byte_format_uses_js_multiline_semantics():
    assert fmt("byte", "aGk=") and not fmt("byte", "!!!")
    assert fmt("byte", "!!!\n") and fmt("byte", " ")  # an empty line matches under /m


@pytest.mark.parametrize(
    "pattern,value,valid",
    [
        ("^[0-9]+$", "123", True),
        ("^[0-9]+$", "123\n", False),
        ("^\\d+$", "١٢", False),  # \d is ASCII in JS
        ("^\\s*$", " ﻿", True),  # JS whitespace includes NBSP and BOM
        ("^\\s*$", "\x1c", False),
        ("^a.c$", "a c", False),
        ("^(?<p>[a-z]+)\\/\\k<p>$", "foo/foo", True),
        ("^\\u{1F600}$", "\U0001F600", True),
    ],
)
def test_pattern_uses_javascript_regex_semantics(pattern, value, valid):
    assert ok({"properties": {"x": {"type": "string", "pattern": pattern}}}, {"x": value}) is valid


def test_effective_schema_defaults():
    assert ok(None, 5) and ok({}, "x") and ok(True, 1)
    assert not ok({"properties": {}}, {"extra": 1})  # additionalProperties defaults to false
    assert not ok({"properties": {}}, [])  # type defaults to object
    assert ok({"properties": {}, "additionalProperties": True}, {"extra": 1})
    assert ok({"type": "integer"}, 1.0)


def test_compiled_validators_are_cached():
    schema_validate._compiled.cache_clear()
    schema = {"properties": {"n": {"type": "integer"}}}
    for _ in range(5):
        validate_against_schema(schema, {"n": 1})
    info = schema_validate._compiled.cache_info()
    assert info.misses == 1 and info.hits == 4


def test_translate_js_regex_dollar_and_dot():
    assert translate_js_regex("a$") == "a\\Z"
    assert translate_js_regex("a.b").startswith("a[^")
