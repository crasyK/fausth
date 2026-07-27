from __future__ import annotations

import hashlib
import json
from typing import Any

INT53_MAX = 9007199254740991
INT53_MIN = -9007199254740991


def assert_integer_deep(value: Any, path: str = "$") -> None:
    if value is None or isinstance(value, (bool, str)):
        return
    if isinstance(value, int) and not isinstance(value, bool):
        if value < INT53_MIN or value > INT53_MAX:
            raise ValueError(f"Integer out of portable int53 range at {path}: {value}")
        return
    if isinstance(value, float):
        raise ValueError(f"Non-integer number at {path}: {value}")
    if isinstance(value, list):
        for i, v in enumerate(value):
            assert_integer_deep(v, f"{path}[{i}]")
        return
    if isinstance(value, dict):
        for k, v in value.items():
            assert_integer_deep(v, f"{path}.{k}")
        return
    raise ValueError(f"Unsupported type at {path}: {type(value)}")


def sort_keys(value: Any) -> Any:
    if isinstance(value, list):
        return [sort_keys(v) for v in value]
    if isinstance(value, dict):
        return {k: sort_keys(value[k]) for k in sorted(value.keys())}
    return value


def canonical_json(value: Any) -> str:
    assert_integer_deep(value)
    return json.dumps(sort_keys(value), separators=(",", ":"), ensure_ascii=False)


def deep_eq(a: Any, b: Any) -> bool:
    try:
        return canonical_json(a) == canonical_json(b)
    except (ValueError, TypeError):
        return False


def state_hash(state: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(state).encode("utf-8")).hexdigest()
