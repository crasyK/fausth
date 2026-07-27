from __future__ import annotations

from typing import Any

from .canonical import deep_eq

MISSING = object()


def get_path(snapshot: dict[str, Any], path: str) -> Any:
    cur: Any = snapshot
    for p in path.split("."):
        if not isinstance(cur, dict) or p not in cur:
            return MISSING
        cur = cur[p]
    return cur


def is_missing(v: Any) -> bool:
    return v is MISSING


def eval_predicate(pred: dict[str, Any], snapshot: dict[str, Any]) -> bool:
    if "all" in pred:
        return all(eval_predicate(p, snapshot) for p in pred["all"])
    if "any" in pred:
        return any(eval_predicate(p, snapshot) for p in pred["any"])
    if "not" in pred:
        return not eval_predicate(pred["not"], snapshot)
    path = pred["path"]
    value = get_path(snapshot, path)
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
        if is_missing(value):
            return False
        return not deep_eq(value, pred["neq"])
    if is_missing(value) or not isinstance(value, int) or isinstance(value, bool):
        return False
    if "lt" in pred:
        return value < pred["lt"]
    if "lte" in pred:
        return value <= pred["lte"]
    if "gt" in pred:
        return value > pred["gt"]
    if "gte" in pred:
        return value >= pred["gte"]
    return False
