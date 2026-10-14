"""Tool schema validation matches TS (Ajv 2020, spec-v0.3 semantics: formats not asserted)."""
import pytest

from fausth import schema_validate
from fausth.schema_validate import FORMAT_NAMES, translate_js_regex, validate_against_schema


def ok(schema, data):
    return validate_against_schema(schema, data)[0]


def fmt(name, value):
    return ok({"properties": {"x": {"format": name}}}, {"x": value})


# spec-v0.3 §6.1: tool schemas are standard JSON Schema 2020-12 and `format` is an annotation,
# not an assertion (TS: Ajv with validateFormats: false). Values that a format checker would
# reject are still valid; the cross-engine schema parity section checks the same 1343 cases.
@pytest.mark.parametrize(
    "name,value",
    [
        ("email", "a@b"), ("email", "a..b@c.de"), ("email", "é@b.co"),
        ("uri", "x.com"), ("uri", "a b"), ("date-time", "2020-02-30T10:00:00Z"),
        ("date", ""), ("byte", "!!!"), ("int32", 2**31), ("unknown-format", "anything"),
    ],
)
def test_format_is_not_asserted(name, value):
    assert fmt(name, value)


def test_all_ajv_full_formats_registered():
    for name in (
        "date", "time", "date-time", "iso-time", "iso-date-time", "duration", "uri", "uri-reference",
        "uri-template", "url", "email", "hostname", "ipv4", "ipv6", "regex", "uuid", "json-pointer",
        "json-pointer-uri-fragment", "relative-json-pointer", "byte", "int32", "int64", "float", "double",
        "password", "binary",
    ):
        assert name in FORMAT_NAMES


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


def test_standard_schema_semantics_no_injected_defaults():
    assert ok(None, 5) and ok({}, "x") and ok(True, 1)
    assert ok({"properties": {}}, {"extra": 1})  # missing additionalProperties = allowed
    assert ok({"properties": {}}, [])  # no implicit type: object
    assert not ok({"properties": {}, "additionalProperties": False}, {"extra": 1})
    assert ok({"type": "integer"}, 1.0)
    assert ok({"$id": "https://example.com/x", "type": "integer"}, 3)  # top-level $id ignored


def test_compiled_validators_are_cached():
    schema_validate._compiled_standard.cache_clear()
    schema = {"properties": {"n": {"type": "integer"}}}
    for _ in range(5):
        validate_against_schema(schema, {"n": 1})
    info = schema_validate._compiled_standard.cache_info()
    assert info.misses == 1 and info.hits == 4


def test_translate_js_regex_dollar_and_dot():
    assert translate_js_regex("a$") == "a\\Z"
    assert translate_js_regex("a.b").startswith("a[^")
