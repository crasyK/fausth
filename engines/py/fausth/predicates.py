from __future__ import annotations

from typing import Any


def get_path(snapshot: dict[str, Any], path: str) -> Any:
    cur: Any = snapshot
    for p in path.split("."):
        if not isinstance(cur, dict) or p not in cur:
            return None
        cur = cur[p]
    return cur


def deep_eq(a: Any, b: Any) -> bool:
    return a == b


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
        return deep_eq(value, get_path(snapshot, pred["eq_path"]))
    if "eq" in pred:
        return deep_eq(value, pred["eq"])
    if "neq" in pred:
        return not deep_eq(value, pred["neq"])
    if not isinstance(value, int) or isinstance(value, bool):
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
