from __future__ import annotations

from typing import Any

from .predicates import eval_predicate, get_path, is_missing


def _leaf_require_constraint(pred: dict[str, Any]) -> dict[str, Any]:
    for key in ("eq", "neq", "eq_path", "lt", "lte", "gt", "gte"):
        if key in pred:
            return {key: pred[key]}
    return {}


def failing_predicates(pred: dict[str, Any], snap: dict[str, Any]) -> list[dict[str, Any]]:
    if not isinstance(pred, dict):
        return []
    if "all" in pred:
        out: list[dict[str, Any]] = []
        for p in pred["all"]:
            out.extend(failing_predicates(p, snap))
        return out
    if "any" in pred:
        if eval_predicate(pred, snap):
            return []
        out = []
        for p in pred["any"]:
            out.extend(failing_predicates(p, snap))
        return out
    if "not" in pred:
        return [pred] if eval_predicate(pred["not"], snap) else []
    return [] if eval_predicate(pred, snap) else [pred]


def _lookup_unblock(
    key: str,
    eq_value: Any,
    checkpoints: list[dict[str, Any]],
) -> dict[str, Any] | None:
    for cp in checkpoints:
        if key in (cp.get("allow_set_keys") or []):
            return {"tool": cp["tool"], "set_key": key, "set_value": eq_value}
    return None


def build_predicate_failure(
    pred: dict[str, Any],
    snap: dict[str, Any],
    checkpoints: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    failed: list[dict[str, Any]] = []
    for p in failing_predicates(pred, snap):
        if "path" not in p:
            continue
        path = str(p["path"])
        key = path[len("state.") :] if path.startswith("state.") else path
        current = get_path(snap, path)
        item: dict[str, Any] = {
            "path": path,
            "current": None if is_missing(current) else current,
            "require": _leaf_require_constraint(p),
        }
        if "eq" in p:
            unblock = _lookup_unblock(key, p["eq"], checkpoints or [])
            if unblock:
                item["unblock"] = unblock
        failed.append(item)
    return {"kind": "predicate", "failed": failed}


def build_missing_prior_tools_failure(missing: list[str]) -> dict[str, Any]:
    return {"kind": "missing_prior_tools", "missing_prior_tools": sorted(missing)}


def build_missing_prior_any_of_failure(options: list[str]) -> dict[str, Any]:
    return {"kind": "missing_prior_any_of", "options": sorted(options)}


def build_checkpoint_key_failure(key: str) -> dict[str, Any]:
    return {"kind": "checkpoint_key", "checkpoint_key": key}
