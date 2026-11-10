"""JSON Schema 2020-12 for tool and handler schemas (spec §3.2), with ECMA-262 patterns."""
from __future__ import annotations

import re
from typing import Any, Callable, Iterator

from jsonschema import Draft202012Validator
from jsonschema_specifications import REGISTRY
from referencing.exceptions import Unresolvable
from referencing.jsonschema import DRAFT202012

from .values import _utf16, canonical

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


_TYPE_NAMES = {"string": "a string", "integer": "an integer", "number": "a number", "boolean": "a boolean",
               "object": "an object", "array": "an array", "null": "null"}


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _has_type(v: Any, t: str) -> bool:
    if t == "string":
        return isinstance(v, str)
    if t == "integer":
        return _is_number(v) and (isinstance(v, int) or float(v).is_integer())
    if t == "number":
        return _is_number(v)
    if t == "boolean":
        return isinstance(v, bool)
    if t == "object":
        return isinstance(v, dict)
    if t == "array":
        return isinstance(v, list)
    return t == "null" and v is None


def _member_reason(p: Any, v: Any) -> str | None:
    """The first row of §8.1's table that the value fails, or None."""
    if p is False:
        return "not allowed"
    if not isinstance(p, dict):
        return None
    types = p.get("type")
    if isinstance(types, str):
        types = [types]
    if isinstance(types, list) and types and not any(_has_type(v, t) for t in types):
        return "must be " + " or ".join(_TYPE_NAMES.get(t, str(t)) for t in types)
    if isinstance(p.get("enum"), list) and canonical(v) not in [canonical(e) for e in p["enum"]]:
        return "must be one of " + ", ".join(canonical(e) for e in p["enum"])
    if "const" in p and canonical(p["const"]) != canonical(v):
        return "must be " + canonical(p["const"])
    if isinstance(v, str):
        k = len(v)  # code points
        if _is_number(p.get("minLength")) and k < p["minLength"]:
            return f"at least {canonical(p['minLength'])} characters (it has {k})"
        if _is_number(p.get("maxLength")) and k > p["maxLength"]:
            return f"at most {canonical(p['maxLength'])} characters (it has {k})"
        if isinstance(p.get("pattern"), str) and not re.search(js_regex(p["pattern"]), v):
            return f"must match the pattern {p['pattern']}"
    if _is_number(v):
        for key, fails, word in (("minimum", lambda n: v < n, "at least"), ("exclusiveMinimum", lambda n: v <= n, "more than"),
                                 ("maximum", lambda n: v > n, "at most"), ("exclusiveMaximum", lambda n: v >= n, "less than")):
            if _is_number(p.get(key)) and fails(p[key]):
                return f"{word} {canonical(p[key])}"
    if isinstance(v, list):
        k = len(v)
        if _is_number(p.get("minItems")) and k < p["minItems"]:
            return f"at least {canonical(p['minItems'])} items (it has {k})"
        if _is_number(p.get("maxItems")) and k > p["maxItems"]:
            return f"at most {canonical(p['maxItems'])} items (it has {k})"
    return None


def argument_reasons(schema: Any, args: Any) -> str:
    """Why arguments fail a tool's input schema (spec §8.1), for arguments JSON Schema has rejected."""
    if not isinstance(schema, dict):
        return "does not match the input schema"
    if schema.get("type") == "object" and not isinstance(args, dict):
        return "the arguments must be a JSON object"
    out: list[str] = []
    if isinstance(args, dict):
        props = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
        for name in schema.get("required") or []:
            if isinstance(name, str) and name not in args:
                out.append(f"missing required member {name}")
        if schema.get("additionalProperties") is False and "patternProperties" not in schema:
            names = ", ".join(sorted(props, key=_utf16))
            for name in sorted(args, key=_utf16):
                if name not in props:
                    out.append(f"unknown member {name} " + (f"(members: {names})" if props else "(no members)"))
        for name in sorted(args, key=_utf16):
            if name in props:
                reason = _member_reason(props[name], args[name])
                if reason is not None:
                    out.append(f"{name}: {reason}")
    return "; ".join(out) if out else "does not match the input schema"
