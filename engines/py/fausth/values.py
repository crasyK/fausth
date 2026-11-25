"""Values (spec §1): canonical form (RFC 8785), hash, excerpt, member order and the argument text (§9.4)."""
from __future__ import annotations

import hashlib
import json
import math
import re
from typing import Any

_LONE_SURROGATE = re.compile("[" + chr(0xD800) + "-" + chr(0xDFFF) + "]")
_ARRAY_INDEX = re.compile(r"(?:0|[1-9][0-9]*)\Z")

TRUNCATED = "…[truncated]"


def parse_json(text: str) -> Any:
    """Read JSON text. NaN and Infinity are not JSON (Python's reader accepts them by default)."""
    return json.loads(text, parse_constant=_not_json, parse_int=lambda s: number(int(s)))


def _not_json(name: str) -> Any:
    raise ValueError(f"{name} is not JSON")


def number(n: int) -> int | float:
    """An integer as the double an engine reads (§1): exact up to 2^53, rounded beyond."""
    if abs(n) <= 2**53:
        return n
    try:
        return float(n)
    except OverflowError:
        return math.inf if n > 0 else -math.inf


def canonical(value: Any) -> str:
    """The canonical form of a JSON value. Raises ValueError if the value has none (§1)."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        try:
            return _number(float(value))  # numbers are doubles (§1)
        except OverflowError:
            raise ValueError("a non-finite number has no canonical form") from None
    if isinstance(value, float):
        return _number(value)
    if isinstance(value, str):
        return _quote(value)
    if isinstance(value, list):
        return "[" + ",".join(canonical(v) for v in value) + "]"
    if isinstance(value, dict):
        if not all(isinstance(k, str) for k in value):
            raise ValueError("object keys must be strings")
        keys = sorted(value, key=_utf16)
        return "{" + ",".join(_quote(k) + ":" + canonical(value[k]) for k in keys) + "}"
    raise ValueError(f"not a JSON value: {type(value).__name__}")


def _utf16(key: str) -> bytes:
    # Big-endian UTF-16 bytes compare like UTF-16 code units, the order RFC 8785 asks for.
    return key.encode("utf-16-be", "surrogatepass")


def _quote(s: str) -> str:
    if _LONE_SURROGATE.search(s):
        raise ValueError("a string with a lone surrogate has no canonical form")
    # json.dumps escapes exactly what ECMAScript JSON.stringify escapes.
    return json.dumps(s, ensure_ascii=False)


def _number(x: float) -> str:
    """ECMAScript Number::toString of a finite double."""
    if not math.isfinite(x):
        raise ValueError("a non-finite number has no canonical form")
    if x == 0:
        return "0"
    if x < 0:
        return "-" + _number(-x)
    # repr gives the shortest digits that round-trip, which is what ECMAScript requires.
    mantissa, _, exp = repr(x).partition("e")
    whole, _, frac = mantissa.partition(".")
    digits = (whole + frac).lstrip("0")
    s = digits.rstrip("0")
    k = len(s)
    n = k + int(exp or 0) - len(frac) + (len(digits) - k)  # x = s × 10^(n−k)
    if k <= n <= 21:
        return s + "0" * (n - k)
    if 0 < n <= 21:
        return s[:n] + "." + s[n:]
    if -6 < n <= 0:
        return "0." + "0" * -n + s
    e = n - 1
    head = s if k == 1 else s[0] + "." + s[1:]
    return f"{head}e{'+' if e >= 0 else '-'}{abs(e)}"


def member_names(obj: dict[str, Any]) -> list[str]:
    """Member order (§1): names that are array indexes first, in ascending numeric order, then the others in
    document order. ECMAScript orders an object's own keys so, and `JSON.parse` keeps it."""
    def index(k: str) -> bool:
        return bool(_ARRAY_INDEX.match(k)) and int(k) < 2**32 - 1

    return sorted((k for k in obj if index(k)), key=int) + [k for k in obj if not index(k)]


def argument_text(value: Any, indented: bool = False) -> str:
    """The argument text of a value (§9.4): compact JSON, members in member order (§1), strings and numbers as in
    the canonical form; with `indented`, two-space indentation. What ECMAScript's `JSON.stringify` writes."""
    canonical(value)  # raises if there is no canonical form
    return _text(value, "\n" if indented else None)


def _text(value: Any, newline: str | None) -> str:
    if isinstance(value, list) and value:
        if newline is None:
            return "[" + ",".join(_text(v, None) for v in value) + "]"
        inner = newline + "  "
        return "[" + inner + ("," + inner).join(_text(v, inner) for v in value) + newline + "]"
    if isinstance(value, dict) and value:
        names = member_names(value)
        if newline is None:
            return "{" + ",".join(_quote(k) + ":" + _text(value[k], None) for k in names) + "}"
        inner = newline + "  "
        return "{" + inner + ("," + inner).join(_quote(k) + ": " + _text(value[k], inner) for k in names) + newline + "}"
    return canonical(value)  # a scalar, [] or {}


def hash(value: Any) -> str:  # noqa: A001 (the spec's name)
    """Lowercase hex SHA-256 of the UTF-8 bytes of the canonical form (§1)."""
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def excerpt(s: str, n: int) -> str:
    """`s` if it has at most `n` code points, else its first `n` code points and `…[truncated]`."""
    return s if len(s) <= n else s[:n] + TRUNCATED
