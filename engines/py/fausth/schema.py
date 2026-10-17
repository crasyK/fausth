"""JSON Schema 2020-12 for tool and handler schemas (spec §3.2), with ECMA-262 patterns."""
from __future__ import annotations

import re
from typing import Any, Callable, Iterator

from jsonschema import Draft202012Validator
from jsonschema_specifications import REGISTRY
from referencing.exceptions import Unresolvable
from referencing.jsonschema import DRAFT202012

_LINE_TERMINATORS = "\n\r" + chr(0x2028) + chr(0x2029)
_JS_SPACE = "\t\n\v\f\r " + "".join(
    chr(c) for c in (0xA0, 0x1680, *range(0x2000, 0x200B), 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF)
)


def js_regex(source: str) -> str:
    """An ECMA-262 (`u` flag) pattern as a Python pattern with the same matches (§3.2)."""
    out = ["(?a)"]  # \d \w \b are ASCII, as in ECMAScript
    in_class = False
    i = 0
    while i < len(source):
        c = source[i]
        if c == "\\" and i + 1 < len(source):
            e = source[i + 1]
            if e == "s":
                out.append(_JS_SPACE if in_class else f"[{_JS_SPACE}]")
            elif e == "S" and not in_class:
                out.append(f"[^{_JS_SPACE}]")
            else:
                out.append(c + e)
            i += 2
            continue
        if in_class:
            in_class = c != "]"
        elif c == "[":
            in_class = True
        elif c == "$":
            c = r"\Z"  # end of input; Python's $ also matches before a final newline
        elif c == ".":
            c = f"[^{_LINE_TERMINATORS}]"
        out.append(c)
        i += 1
    pattern = "".join(out)
    re.compile(pattern)
    return pattern


_SCHEMA_MAPS = ("properties", "$defs", "definitions", "dependentSchemas")
_SCHEMA_LISTS = ("allOf", "anyOf", "oneOf", "prefixItems")
_SCHEMA_ONE = ("additionalProperties", "unevaluatedProperties", "items", "contains", "not", "if", "then",
               "else", "propertyNames", "unevaluatedItems", "contentSchema")


def _translated(schema: Any) -> Any:
    """The schema with every regular expression translated (data inside `const`/`enum` is untouched)."""
    if not isinstance(schema, dict):
        return schema
    out = {}
    for k, v in schema.items():
        if k == "pattern" and isinstance(v, str):
            out[k] = js_regex(v)
        elif k == "patternProperties" and isinstance(v, dict):
            out[k] = {js_regex(p): _translated(s) for p, s in v.items()}
        elif k in _SCHEMA_MAPS and isinstance(v, dict):
            out[k] = {name: _translated(s) for name, s in v.items()}
        elif k in _SCHEMA_LISTS and isinstance(v, list):
            out[k] = [_translated(s) for s in v]
        elif k in _SCHEMA_ONE:
            out[k] = _translated(v)
        else:
            out[k] = v
    return out


def _subschemas(schema: dict) -> Iterator[Any]:
    for k, v in schema.items():
        if k in _SCHEMA_MAPS + ("patternProperties",) and isinstance(v, dict):
            yield from v.values()
        elif k in _SCHEMA_LISTS and isinstance(v, list):
            yield from v
        elif k in _SCHEMA_ONE:
            yield v


def _check_refs(schema: Any, resolver: Any) -> None:
    if not isinstance(schema, dict):
        return
    if "$id" in schema:
        resolver = resolver.in_subresource(DRAFT202012.create_resource(schema))
    for key in ("$ref", "$dynamicRef"):
        if isinstance(schema.get(key), str):
            resolver.lookup(schema[key])
    for sub in _subschemas(schema):
        _check_refs(sub, resolver)


def compile_schema(schema: dict) -> Callable[[Any], bool]:
    """Compile a schema. Raises ValueError if it doesn't compile (bad `$ref`, invalid `pattern`, …)."""
    try:
        translated = _translated(schema)
        _check_refs(translated, REGISTRY.resolver_with_root(DRAFT202012.create_resource(translated)))
    except (re.error, Unresolvable) as e:
        raise ValueError(str(e)) from None
    return Draft202012Validator(translated).is_valid


def structure_validator(schema: dict) -> Draft202012Validator:
    """A validator for the harness schema itself, with its patterns translated."""
    return Draft202012Validator(_translated(schema))
