"""Portable value semantics shared by both engines.

Canonical JSON (spec §1.3, decisions D1–D3) plus the small set of JavaScript
coercions the TypeScript engine relies on (``String()``, ``Number()``,
truthiness, ``??``).  Anything that ends up in an event log must go through
these helpers so that Python and TypeScript see the same values.

Decisions implemented here:

* D1 — object keys sort by Unicode code point.
* D2 — string lengths / truncation count code points (Python ``len`` / slices).
* D3 — integral numbers (``1.0``, ``1e3``) are int53 integers; non-integral,
  ``NaN`` and ``Infinity`` are non-canonical and rejected.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any, Iterable

INT53_MAX = 9007199254740991
INT53_MIN = -9007199254740991


class _Undefined:
    """JavaScript ``undefined``: an absent value, distinct from JSON ``null``.

    Never serialized: canonical JSON rejects it exactly like the TS engine's
    ``assertIntegerDeep`` does.
    """

    __slots__ = ()
    _instance: "_Undefined | None" = None

    def __new__(cls) -> "_Undefined":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __repr__(self) -> str:
        return "UNDEFINED"

    def __bool__(self) -> bool:
        return False

    def __copy__(self) -> "_Undefined":
        return self

    def __deepcopy__(self, memo: dict[int, Any]) -> "_Undefined":
        return self

    def __reduce__(self) -> tuple[Any, ...]:
        return (_Undefined, ())


UNDEFINED: Any = _Undefined()


def is_nullish(v: Any) -> bool:
    """JS ``v == null`` (``null`` or ``undefined``)."""
    return v is None or v is UNDEFINED


def nn(v: Any, default: Any) -> Any:
    """JS nullish coalescing ``v ?? default``."""
    return default if v is None or v is UNDEFINED else v


# --------------------------------------------------------------------------
# JavaScript coercions
# --------------------------------------------------------------------------

#: Characters removed by ``String.prototype.trim`` (WhiteSpace + LineTerminator).
JS_WHITESPACE = (
    "\t\n\x0b\x0c\r \xa0        "
    "        　﻿"
)


def js_trim(s: str) -> str:
    """``String.prototype.trim`` (Python ``str.strip()`` uses a different set)."""
    return s.strip(JS_WHITESPACE)


def js_truthy(v: Any) -> bool:
    """JavaScript truthiness for JSON-like values (``[]`` and ``{}`` are truthy)."""
    if v is None or v is UNDEFINED:
        return False
    if isinstance(v, bool):
        return v
    if isinstance(v, int):
        return v != 0
    if isinstance(v, float):
        return not (v == 0 or math.isnan(v))
    if isinstance(v, str):
        return len(v) > 0
    return True


def _float_digits(x: float) -> tuple[str, int]:
    """Shortest round-trip digits ``d`` and exponent ``n`` with ``x == 0.d × 10^n``."""
    s = repr(abs(x))
    if "e" in s:
        mant, exp_s = s.split("e")
        exp = int(exp_s)
    else:
        mant, exp = s, 0
    if "." in mant:
        int_part, frac = mant.split(".")
    else:
        int_part, frac = mant, ""
    digits = int_part + frac
    point = len(int_part) + exp
    stripped = digits.lstrip("0")
    point -= len(digits) - len(stripped)
    stripped = stripped.rstrip("0")
    return stripped, point


def js_number_to_string(x: float | int) -> str:
    """``Number.prototype.toString()`` (radix 10) — ECMA-262 Number::toString."""
    if isinstance(x, bool):
        return "true" if x else "false"
    if isinstance(x, int):
        if -(10**21) < x < 10**21:
            return str(x)
        x = float(x)
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    if x == 0:
        return "0"
    sign = "-" if x < 0 else ""
    d, n = _float_digits(x)
    k = len(d)
    if k <= n <= 21:
        return sign + d + "0" * (n - k)
    if 0 < n <= 21:
        return sign + d[:n] + "." + d[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + d
    e = n - 1
    es = ("+" if e >= 0 else "-") + str(abs(e))
    if k == 1:
        return sign + d + "e" + es
    return sign + d[0] + "." + d[1:] + "e" + es


def js_string(v: Any) -> str:
    """JavaScript ``String(v)`` for JSON-like values."""
    if v is UNDEFINED:
        return "undefined"
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return js_number_to_string(v)
    if isinstance(v, str):
        return v
    if isinstance(v, (list, tuple)):
        return ",".join("" if is_nullish(x) else js_string(x) for x in v)
    return "[object Object]"


_JS_DECIMAL = re.compile(
    r"[+-]?(?:(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)\Z"
)
_JS_PREFIXED = {
    "0x": (re.compile(r"0[xX][0-9a-fA-F]+\Z"), 16),
    "0o": (re.compile(r"0[oO][0-7]+\Z"), 8),
    "0b": (re.compile(r"0[bB][01]+\Z"), 2),
}


def normalize_number(x: float | int) -> float | int:
    """Integral finite floats become ints (D3); everything else is unchanged."""
    if isinstance(x, float) and math.isfinite(x) and x.is_integer():
        return int(x)
    return x


def js_number(v: Any) -> float | int:
    """JavaScript ``Number(v)``. Integral results are returned as ``int`` (D3)."""
    if v is UNDEFINED:
        return math.nan
    if v is None:
        return 0
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, (int, float)):
        return normalize_number(v)
    if isinstance(v, str):
        s = js_trim(v)
        if s == "":
            return 0
        if s in ("Infinity", "+Infinity"):
            return math.inf
        if s == "-Infinity":
            return -math.inf
        prefix = s[:2].lower()
        if prefix in _JS_PREFIXED:
            rx, base = _JS_PREFIXED[prefix]
            return int(s[2:], base) if rx.match(s) else math.nan
        if _JS_DECIMAL.match(s):
            return normalize_number(float(s))
        return math.nan
    if isinstance(v, (list, tuple)):
        return js_number(js_string(v))
    return math.nan


def is_js_integer(v: Any) -> bool:
    """``typeof v === "number" && Number.isInteger(v)``."""
    if isinstance(v, bool):
        return False
    if isinstance(v, int):
        return True
    return isinstance(v, float) and math.isfinite(v) and v.is_integer()


_INDEX_KEY = re.compile(r"(?:0|[1-9][0-9]*)\Z")


def _is_array_index_key(k: str) -> bool:
    return bool(_INDEX_KEY.match(k)) and int(k) <= 4294967294


def js_keys(obj: dict[str, Any]) -> list[str]:
    """``Object.keys`` order: array-index keys ascending, then insertion order."""
    keys = list(obj.keys())
    idx = sorted((k for k in keys if isinstance(k, str) and _is_array_index_key(k)), key=int)
    if not idx:
        return keys
    idx_set = set(idx)
    return idx + [k for k in keys if k not in idx_set]


def jget(obj: Any, key: str) -> Any:
    """Property read with optional chaining (``obj?.[key]``) on JSON-like values.

    Own keys of objects only; arrays/strings expose ``length`` and indices.
    Returns ``UNDEFINED`` when absent.
    """
    if isinstance(obj, dict):
        return obj.get(key, UNDEFINED)
    if isinstance(obj, (list, str)):
        if key == "length":
            return utf16_length(obj) if isinstance(obj, str) else len(obj)
        if _is_array_index_key(key) and int(key) < len(obj) and isinstance(obj, list):
            return obj[int(key)]
    return UNDEFINED


def utf16_length(s: str) -> int:
    """JS ``String.prototype.length`` (UTF-16 code units)."""
    return len(s) + sum(1 for ch in s if ord(ch) > 0xFFFF)


# --------------------------------------------------------------------------
# Strings: UTF-16 surrogate handling
# --------------------------------------------------------------------------

_SURROGATE_PAIR = re.compile("[\ud800-\udbff][\udc00-\udfff]")


def combine_surrogates(s: str) -> str:
    """Join UTF-16 surrogate pairs into code points (JS strings are UTF-16)."""
    if not any("\ud800" <= ch <= "\udfff" for ch in s):
        return s
    return _SURROGATE_PAIR.sub(
        lambda m: chr(
            0x10000 + ((ord(m.group(0)[0]) - 0xD800) << 10) + (ord(m.group(0)[1]) - 0xDC00)
        ),
        s,
    )


# --------------------------------------------------------------------------
# Canonical JSON
# --------------------------------------------------------------------------

_ESCAPE_RE = re.compile('[\x00-\x1f"\\\\\ud800-\udfff]')
_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
}


def _escape_char(m: re.Match[str]) -> str:
    c = m.group(0)
    return _ESCAPES.get(c) or "\\u%04x" % ord(c)


def quote_json_string(s: str) -> str:
    """``JSON.stringify`` for a string (well-formed: lone surrogates escaped)."""
    return '"' + _ESCAPE_RE.sub(_escape_char, combine_surrogates(s)) + '"'


def _type_name(v: Any) -> str:
    if v is UNDEFINED:
        return "undefined"
    return type(v).__name__


def assert_integer_deep(value: Any, path: str = "$") -> None:
    """Raise ``ValueError`` unless ``value`` is canonical (mirrors TS assertIntegerDeep)."""
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, str):
        if any(0xD800 <= ord(ch) <= 0xDFFF for ch in combine_surrogates(value)):
            raise ValueError(f"Non-canonical value at {path}: string is not well-formed Unicode")
        return
    if isinstance(value, int):
        if value < INT53_MIN or value > INT53_MAX:
            raise ValueError(f"Integer out of portable int53 range at {path}: {value}")
        return
    if isinstance(value, float):
        if not (math.isfinite(value) and value.is_integer()):
            raise ValueError(f"Non-integer number at {path}: {js_number_to_string(value)}")
        if value < INT53_MIN or value > INT53_MAX:
            raise ValueError(
                f"Integer out of portable int53 range at {path}: {js_number_to_string(value)}"
            )
        return
    if isinstance(value, (list, tuple)):
        for i, v in enumerate(value):
            assert_integer_deep(v, f"{path}[{i}]")
        return
    if isinstance(value, dict):
        for k in js_keys(value):
            if isinstance(k, str) and any(0xD800 <= ord(ch) <= 0xDFFF for ch in combine_surrogates(k)):
                raise ValueError(f"Non-canonical value at {path}: key is not well-formed Unicode")
            assert_integer_deep(value[k], f"{path}.{k}")
        return
    raise ValueError(f"Unsupported type at {path}: {_type_name(value)}")


def is_canonical(value: Any) -> bool:
    try:
        assert_integer_deep(value)
    except ValueError:
        return False
    return True


def _encode(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return quote_json_string(value)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return str(int(value))
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_encode(v) for v in value) + "]"
    if isinstance(value, dict):
        items = sorted(
            ((combine_surrogates(_key_str(k)), v) for k, v in value.items()), key=lambda kv: kv[0]
        )
        return "{" + ",".join(quote_json_string(k) + ":" + _encode(v) for k, v in items) + "}"
    raise ValueError(f"Unsupported type: {_type_name(value)}")


def _key_str(k: Any) -> str:
    """Object keys are strings in JS; coerce stray non-string keys like ``String(k)``."""
    return k if isinstance(k, str) else js_string(k)


def sort_keys(value: Any) -> Any:
    """Deep copy with object keys in code-point order (D1)."""
    if isinstance(value, (list, tuple)):
        return [sort_keys(v) for v in value]
    if isinstance(value, dict):
        items = sorted(
            ((combine_surrogates(_key_str(k)), v) for k, v in value.items()), key=lambda kv: kv[0]
        )
        return {k: sort_keys(v) for k, v in items}
    return value


def canonical_json(value: Any) -> str:
    """Compact JSON, keys sorted by code point, int53 integers only (spec §1.3)."""
    assert_integer_deep(value)
    return _encode(value)


def deep_eq(a: Any, b: Any) -> bool:
    """Canonical-JSON equality; non-canonical values are never equal (TS deepEq)."""
    try:
        return canonical_json(a) == canonical_json(b)
    except (ValueError, TypeError):
        return False


def state_hash(state: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(state).encode("utf-8")).hexdigest()


def js_json_stringify(value: Any) -> str:
    """Plain ``JSON.stringify`` (insertion order, no sorting) for diagnostics."""
    if value is UNDEFINED:
        return "undefined"
    if value is None or value is True or value is False:
        return _encode(value)
    if isinstance(value, str):
        return quote_json_string(value)
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            return "null"
        return js_number_to_string(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join("null" if is_nullish(v) else js_json_stringify(v) for v in value) + "]"
    if isinstance(value, dict):
        parts = [
            quote_json_string(k) + ":" + js_json_stringify(value[k])
            for k in js_keys(value)
            if value[k] is not UNDEFINED
        ]
        return "{" + ",".join(parts) + "}"
    return "null"


# --------------------------------------------------------------------------
# JSON / JSONL input (D3: integral floats are integers; NaN/Infinity rejected)
# --------------------------------------------------------------------------


def _parse_float(s: str) -> float | int:
    return normalize_number(float(s))


def _reject_constant(name: str) -> Any:
    raise ValueError(f"Invalid JSON: non-standard constant {name}")


def normalize_json_value(value: Any) -> Any:
    """Normalize an already-decoded JSON-like value: integral floats → int,
    UTF-16 surrogate pairs joined. Used for values decoded elsewhere."""
    if isinstance(value, float):
        return normalize_number(value)
    if isinstance(value, str):
        return combine_surrogates(value)
    if isinstance(value, list):
        return [normalize_json_value(v) for v in value]
    if isinstance(value, dict):
        return {combine_surrogates(k): normalize_json_value(v) for k, v in value.items()}
    return value


def json_loads(text: str) -> Any:
    """``JSON.parse`` equivalent: integral numbers decode as ``int`` (D3) and the
    non-standard ``NaN``/``Infinity`` constants are rejected."""
    return json.loads(text, parse_float=_parse_float, parse_constant=_reject_constant)


def read_text_utf8(path: str | Path) -> str:
    """``readFileSync(path, "utf8")``: no newline translation, invalid bytes → U+FFFD."""
    return Path(path).read_bytes().decode("utf-8", errors="replace")


_LINE_SPLIT = re.compile(r"\r?\n")


def split_jsonl_lines(text: str) -> list[str]:
    """Non-blank lines exactly like TS ``readJsonl`` (split on ``\\r?\\n`` only)."""
    return [line for line in _LINE_SPLIT.split(text) if js_trim(line)]


def read_jsonl(path: str | Path) -> list[Any]:
    return [json_loads(line) for line in split_jsonl_lines(read_text_utf8(path))]


def jsonl_lines(events: Iterable[Any]) -> str:
    return "".join(canonical_json(e) + "\n" for e in events)
