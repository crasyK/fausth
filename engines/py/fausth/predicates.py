"""Gate / verify predicate language (spec v0.1 §3).

Path resolution follows D16: a path segment resolves only an *own key of a JSON
object*. Arrays, strings and other values never expose implicit members
(``length``, indices, prototype names such as ``constructor``) — those paths are
``MISSING``.
"""
from __future__ import annotations

import math
from typing import Any

from .canonical import deep_eq, is_js_integer, js_number

MISSING = object()


def get_path(snapshot: Any, path: str) -> Any:
    cur: Any = snapshot
    for p in path.split("."):
        if not isinstance(cur, dict) or p not in cur:
            return MISSING
        cur = cur[p]
    return cur


def is_missing(v: Any) -> bool:
    return v is MISSING


def _compare(value: Any, bound: Any, op: str) -> bool:
    """JS relational comparison of an integer value against the declared bound."""
    b = bound if is_js_integer(bound) else js_number(bound)
    if isinstance(b, float) and math.isnan(b):
        return False
    if op == "lt":
        return value < b
    if op == "lte":
        return value <= b
    if op == "gt":
        return value > b
    return value >= b


def eval_predicate(pred: dict[str, Any], snapshot: Any) -> bool:
    if "all" in pred:
        return all(eval_predicate(p, snapshot) for p in pred["all"])
    if "any" in pred:
        return any(eval_predicate(p, snapshot) for p in pred["any"])
    if "not" in pred:
        return not eval_predicate(pred["not"], snapshot)
    value = get_path(snapshot, pred["path"])
    if "eq_path" in pred:
        other = get_path(snapshot, pred["eq_path"])
        if is_missing(value) and is_missing(other):
            return True
        if is_missing(value) or is_missing(other):
            return False
        return deep_eq(value, other)
    if "eq" in pred:
        if is_missing(value):
            return False
        return deep_eq(value, pred["eq"])
    if "neq" in pred:
        # Missing is absent, not "not equal".
        if is_missing(value):
            return False
        return not deep_eq(value, pred["neq"])
    if is_missing(value) or not is_js_integer(value):
        return False
    for op in ("lt", "lte", "gt", "gte"):
        if op in pred:
            return _compare(value, pred[op], op)
    return False
