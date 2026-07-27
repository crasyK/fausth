from __future__ import annotations

from typing import Any

from jsonschema import Draft202012Validator


def validate_against_schema(
    schema: dict[str, Any] | None, data: Any
) -> tuple[bool, list[str]]:
    if not schema:
        return True, []
    effective = dict(schema)
    if "type" not in effective:
        effective["type"] = "object"
    if "additionalProperties" not in effective:
        effective["additionalProperties"] = False
    validator = Draft202012Validator(effective)
    errors = sorted(validator.iter_errors(data), key=lambda e: list(e.path))
    if not errors:
        return True, []
    msgs = []
    for e in errors:
        path = "/" + "/".join(str(p) for p in e.path) if e.path else "/"
        msgs.append(f"{path} {e.message}")
    return False, msgs
