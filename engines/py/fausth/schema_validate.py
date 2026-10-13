"""Tool I/O JSON Schema validation — Python twin of TS ``schema-validate.ts``.

The TS engine uses Ajv (draft 2020-12, ``strict: false``) plus ``ajv-formats``
in its default *full* mode. This module reproduces that behaviour with
``jsonschema``:

* every ajv-formats "full" format is checked with the same regular
  expressions / validation functions (ported, with JS→Python regex dialect
  differences handled: ``$``, ``.``, ``\\d``, ``\\s`` …);
* ``pattern`` / ``patternProperties`` use JavaScript (``u`` flag) regex
  semantics, translated to Python ``re``;
* compiled validators are cached (PY-14).
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from typing import Any, Callable

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import ValidationError
from jsonschema.validators import extend

from .canonical import JS_WHITESPACE, is_js_integer

# --------------------------------------------------------------------------
# JavaScript RegExp → Python ``re`` translation (ajv compiles with flag "u")
# --------------------------------------------------------------------------

_WS_CLASS = "".join(f"\\u{ord(c):04x}" for c in JS_WHITESPACE)
_LINE_TERMINATORS = "\\n\\r\\u2028\\u2029"


class JsRegexError(ValueError):
    pass


def translate_js_regex(src: str, multiline: bool = False) -> str:
    """Translate a JS (unicode-mode) regular expression source to Python syntax.

    Handles the dialect differences that change match results: ``$`` (end of
    input only), ``.`` (no line terminators), ``\\d``/``\\w``/``\\s`` (ASCII /
    JS whitespace sets), ``\\u{…}`` escapes, named groups and ``[^]``.
    """
    out: list[str] = []
    i = 0
    n = len(src)
    in_class = False
    while i < n:
        c = src[i]
        if c == "\\":
            if i + 1 >= n:
                raise JsRegexError("\\ at end of pattern")
            e = src[i + 1]
            if e == "u" and i + 2 < n and src[i + 2] == "{":
                end = src.find("}", i + 3)
                if end < 0:
                    raise JsRegexError("unterminated \\u{")
                cp = int(src[i + 3:end], 16)
                out.append(re.escape(chr(cp)) if not in_class else _class_escape(chr(cp)))
                i = end + 1
                continue
            if e == "s":
                out.append(_WS_CLASS if in_class else f"[{_WS_CLASS}]")
            elif e == "S":
                out.append(f"[^{_WS_CLASS}]" if not in_class else "\\S")
            elif e == "d":
                out.append("0-9" if in_class else "[0-9]")
            elif e == "w":
                out.append("A-Za-z0-9_" if in_class else "[A-Za-z0-9_]")
            elif e == "k" and i + 2 < n and src[i + 2] == "<":
                end = src.find(">", i + 3)
                if end < 0:
                    raise JsRegexError("bad \\k<name>")
                out.append(f"(?P={src[i + 3:end]})")
                i = end + 1
                continue
            elif e == "/":
                out.append("/")
            elif e in "AZz":
                raise JsRegexError(f"invalid escape \\{e} in unicode mode")
            else:
                out.append(c + e)
            i += 2
            continue
        if in_class:
            if c == "]":
                in_class = False
            elif c == "[":
                out.append("\\[")
                i += 1
                continue
            out.append(c)
            i += 1
            continue
        if c == "[":
            if src.startswith("[^]", i):
                out.append("[\\s\\S]")
                i += 3
                continue
            if src.startswith("[]", i):
                out.append("(?!)")
                i += 2
                continue
            in_class = True
            out.append(c)
            i += 1
            if i < n and src[i] == "^":
                out.append("^")
                i += 1
            continue
        if c == "$":
            # JS: end of input (or before any line terminator with the m flag).
            out.append(f"(?=[{_LINE_TERMINATORS}]|\\Z)" if multiline else "\\Z")
            i += 1
            continue
        if c == "^" and multiline:
            out.append(f"(?:(?<=[{_LINE_TERMINATORS}])|\\A)")
            i += 1
            continue
        if c == ".":
            out.append(f"[^{_LINE_TERMINATORS}]")
            i += 1
            continue
        if c == "(" and src.startswith("(?<", i) and i + 3 < n and src[i + 3] not in "=!":
            out.append("(?P<")
            i += 3
            continue
        if c == "(" and src.startswith("(?P", i):
            raise JsRegexError("(?P…) is not JavaScript syntax")
        out.append(c)
        i += 1
    return "".join(out)


def _class_escape(ch: str) -> str:
    return "\\" + ch if ch in "\\]^-[" else ch


@lru_cache(maxsize=512)
def compile_js_regex(src: str, flags: str = "u") -> re.Pattern[str]:
    pyflags = re.ASCII
    if "i" in flags:
        pyflags |= re.IGNORECASE
        if "u" in flags:
            pyflags &= ~re.ASCII  # unicode case folding
    if "s" in flags:
        pyflags |= re.DOTALL
    return re.compile(translate_js_regex(src, multiline="m" in flags), pyflags)


# --------------------------------------------------------------------------
# ajv-formats (full mode)
# --------------------------------------------------------------------------

def _rx(src: str, flags: str = "") -> Callable[[str], bool]:
    pattern = compile_js_regex(src, flags)
    return lambda s: pattern.search(s) is not None


def _is_leap_year(year: int) -> bool:
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


_DATE = compile_js_regex(r"^(\d\d\d\d)-(\d\d)-(\d\d)$", "")
_DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]


def _date(s: str) -> bool:
    m = _DATE.search(s)
    if not m:
        return False
    year, month, day = int(m.group(1)), int(m.group(2)), int(m.group(3))
    return 1 <= month <= 12 and 1 <= day <= (29 if month == 2 and _is_leap_year(year) else _DAYS[month])


_TIME = compile_js_regex(r"^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(z|([+-])(\d\d)(?::?(\d\d))?)?$", "i")


def _get_time(strict_time_zone: bool) -> Callable[[str], bool]:
    def time(s: str) -> bool:
        m = _TIME.search(s)
        if not m:
            return False
        hr = int(m.group(1))
        mn = int(m.group(2))
        sec = float(m.group(3))
        tz = m.group(4)
        tz_sign = -1 if m.group(5) == "-" else 1
        tz_h = int(m.group(6) or 0)
        tz_m = int(m.group(7) or 0)
        if tz_h > 23 or tz_m > 59 or (strict_time_zone and not tz):
            return False
        if hr <= 23 and mn <= 59 and sec < 60:
            return True
        utc_min = mn - tz_m * tz_sign
        utc_hr = hr - tz_h * tz_sign - (1 if utc_min < 0 else 0)
        return (utc_hr == 23 or utc_hr == -1) and (utc_min == 59 or utc_min == -1) and sec < 61

    return time


_DATE_TIME_SEPARATOR = re.compile(f"[tT]|[{_WS_CLASS}]")


def _get_date_time(strict_time_zone: bool) -> Callable[[str], bool]:
    time = _get_time(strict_time_zone)

    def date_time(s: str) -> bool:
        parts = _DATE_TIME_SEPARATOR.split(s)
        return len(parts) == 2 and _date(parts[0]) and time(parts[1])

    return date_time


_URI = compile_js_regex(
    r"^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)(?:\?(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?$",
    "i",
)
_NOT_URI_FRAGMENT = re.compile(r"/|:")


def _uri(s: str) -> bool:
    return bool(_NOT_URI_FRAGMENT.search(s)) and _URI.search(s) is not None


_BYTE = compile_js_regex(r"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$", "m")


def _byte(s: str) -> bool:
    return _BYTE.search(s) is not None


_Z_ANCHOR = re.compile(r"[^\\]\\Z")


def _regex(s: str) -> bool:
    if _Z_ANCHOR.search(s):
        return False
    try:
        re.compile(translate_js_regex(s))
        return True
    except (re.error, JsRegexError, ValueError, OverflowError):
        return False


_STRING_FORMATS: dict[str, Callable[[str], bool]] = {
    "date": _date,
    "time": _get_time(True),
    "date-time": _get_date_time(True),
    "iso-time": _get_time(False),
    "iso-date-time": _get_date_time(False),
    "duration": _rx(r"^P(?!$)((\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?|(\d+W)?)$"),
    "uri": _uri,
    "uri-reference": _rx(
        r"^(?:[a-z][a-z0-9+\-.]*:)?(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'\"()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'\"()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'\"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'\"()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'\"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'\"()*+,;=:@]|%[0-9a-f]{2})*)*)?(?:\?(?:[a-z0-9\-._~!$&'\"()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'\"()*+,;=:@/?]|%[0-9a-f]{2})*)?$",
        "i",
    ),
    "uri-template": _rx(
        r"^(?:(?:[^\x00-\x20\"'<>%\\^`{|}]|%[0-9a-f]{2})|\{[+#./;?&=,!@|]?(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?(?:,(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?)*\})*$",
        "i",
    ),
    "url": _rx(
        r"^(?:https?|ftp):\/\/(?:\S+(?::\S*)?@)?(?:(?!(?:10|127)(?:\.\d{1,3}){3})(?!(?:169\.254|192\.168)(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)(?:\.(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)*(?:\.(?:[a-z\u{00a1}-\u{ffff}]{2,})))(?::\d{2,5})?(?:\/[^\s]*)?$",
        "iu",
    ),
    "email": _rx(
        r"^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$",
        "i",
    ),
    "hostname": _rx(
        r"^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*\.?$",
        "i",
    ),
    "ipv4": _rx(r"^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$"),
    "ipv6": _rx(
        r"^((([0-9a-f]{1,4}:){7}([0-9a-f]{1,4}|:))|(([0-9a-f]{1,4}:){6}(:[0-9a-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){5}(((:[0-9a-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){4}(((:[0-9a-f]{1,4}){1,3})|((:[0-9a-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){3}(((:[0-9a-f]{1,4}){1,4})|((:[0-9a-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){2}(((:[0-9a-f]{1,4}){1,5})|((:[0-9a-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){1}(((:[0-9a-f]{1,4}){1,6})|((:[0-9a-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9a-f]{1,4}){1,7})|((:[0-9a-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))$",
        "i",
    ),
    "regex": _regex,
    "uuid": _rx(r"^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$", "i"),
    "json-pointer": _rx(r"^(?:\/(?:[^~/]|~0|~1)*)*$"),
    "json-pointer-uri-fragment": _rx(
        r"^#(?:\/(?:[a-z0-9_\-.!$&'()*+,;:=@]|%[0-9a-f]{2}|~0|~1)*)*$", "i"
    ),
    "relative-json-pointer": _rx(r"^(?:0|[1-9][0-9]*)(?:#|(?:\/(?:[^~/]|~0|~1)*)*)$"),
    "byte": _byte,
    "password": lambda s: True,
    "binary": lambda s: True,
}

_INT32_MIN = -(2**31)
_INT32_MAX = 2**31 - 1


_NUMBER_FORMATS: dict[str, Callable[[Any], bool]] = {
    "int32": lambda v: is_js_integer(v) and _INT32_MIN <= v <= _INT32_MAX,
    "int64": is_js_integer,
    "float": lambda v: True,
    "double": lambda v: True,
}


def _build_format_checker() -> FormatChecker:
    checker = FormatChecker(formats=())
    for name, fn in _STRING_FORMATS.items():

        def check(instance: Any, _fn: Callable[[str], bool] = fn) -> bool:
            if not isinstance(instance, str):
                return True
            return bool(_fn(instance))

        checker.checks(name)(check)
    for name, fn in _NUMBER_FORMATS.items():

        def check_num(instance: Any, _fn: Callable[[Any], bool] = fn) -> bool:
            if isinstance(instance, bool) or not isinstance(instance, (int, float)):
                return True
            return bool(_fn(instance))

        checker.checks(name)(check_num)
    return checker


FORMAT_CHECKER = _build_format_checker()

#: Format names enforced (ajv-formats ``formatNames``, full mode).
FORMAT_NAMES = tuple(list(_STRING_FORMATS) + list(_NUMBER_FORMATS))


# --------------------------------------------------------------------------
# Validator class with JS-regex ``pattern`` semantics
# --------------------------------------------------------------------------


def _pattern(validator: Any, patrn: str, instance: Any, schema: dict[str, Any]) -> Any:
    if validator.is_type(instance, "string") and not compile_js_regex(patrn).search(instance):
        yield ValidationError(f"{instance!r} does not match {patrn!r}")


def _pattern_properties(validator: Any, pattern_properties: dict[str, Any], instance: Any, schema: dict[str, Any]) -> Any:
    if not validator.is_type(instance, "object"):
        return
    for pattern, subschema in pattern_properties.items():
        rx = compile_js_regex(pattern)
        for k, v in instance.items():
            if rx.search(k):
                yield from validator.descend(v, subschema, path=k, schema_path=pattern)


def _additional_properties(validator: Any, aP: Any, instance: Any, schema: dict[str, Any]) -> Any:
    if not validator.is_type(instance, "object"):
        return
    props = schema.get("properties", {})
    patterns = [compile_js_regex(p) for p in schema.get("patternProperties", {})]
    extras = [k for k in instance if k not in props and not any(rx.search(k) for rx in patterns)]
    if validator.is_type(aP, "object"):
        for extra in extras:
            yield from validator.descend(instance[extra], aP, path=extra)
    elif not aP and extras:
        yield ValidationError(f"Additional properties are not allowed ({', '.join(map(repr, extras))} unexpected)")


AjvLikeValidator = extend(
    Draft202012Validator,
    {
        "pattern": _pattern,
        "patternProperties": _pattern_properties,
        "additionalProperties": _additional_properties,
    },
)


def _effective_schema(schema: Any) -> dict[str, Any] | None:
    """TS: ``{...schema, type: schema.type ?? "object", additionalProperties: … ?? false}``."""
    if schema is None or isinstance(schema, (bool, int, float)) or not schema:
        return None
    if isinstance(schema, dict):
        effective = dict(schema)
    else:  # spread of a string / array
        effective = {str(i): v for i, v in enumerate(schema)}
    if effective.get("type") is None:
        effective["type"] = "object"
    if "additionalProperties" not in effective:
        effective["additionalProperties"] = False
    return effective


@lru_cache(maxsize=256)
def _compiled(key: str) -> Any:
    return AjvLikeValidator(json.loads(key), format_checker=FORMAT_CHECKER)


def _validator_for(effective: dict[str, Any]) -> Any:
    try:
        key = json.dumps(effective, sort_keys=True, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError):
        return AjvLikeValidator(effective, format_checker=FORMAT_CHECKER)
    return _compiled(key)


def validate_against_schema(schema: Any, data: Any) -> tuple[bool, list[str]]:
    """Validate ``data`` against a tool schema. Empty/missing schema → ok."""
    effective = _effective_schema(schema)
    if effective is None:
        return True, []
    validator = _validator_for(effective)
    errors = sorted(validator.iter_errors(data), key=lambda e: [str(p) for p in e.path])
    if not errors:
        return True, []
    msgs = []
    for e in errors:
        path = "/" + "/".join(str(p) for p in e.path) if e.path else "/"
        msgs.append(f"{path} {e.message}")
    return False, msgs
