from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from .canonical import canonical_json


def _schema_path() -> Path:
    return Path(__file__).resolve().parents[3] / "schema" / "counterbalance-contract.v0.1.json"


def structural_checks(agent: dict[str, Any]) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    if agent.get("safe_state") and not agent.get("fallback_state"):
        warnings.append("safe_state is deprecated; use fallback_state")
    ids: set[str] = set()
    for t in agent.get("tools", []):
        tid = t["id"]
        if tid in ids:
            errors.append(f"Duplicate tool id: {tid}")
        ids.add(tid)
    tools_by_id = {t["id"]: t for t in agent.get("tools", [])}
    for t in agent.get("tools", []):
        for v in t.get("verify") or []:
            if v.get("kind") == "effect":
                obs = tools_by_id.get(v["observe"])
                if not obs:
                    errors.append(f"Tool {t['id']}: effect observe '{v['observe']}' not declared")
                elif obs.get("read_only") is not True:
                    errors.append(
                        f"Tool {t['id']}: observer '{v['observe']}' must have read_only: true"
                    )
    recovery = agent.get("recovery")
    if recovery:
        rt = recovery["execute"]["tool"]
        if rt not in ids:
            errors.append(f"recovery.execute.tool '{rt}' not declared")
        ver = recovery.get("verify") or {}
        if ver.get("kind") == "effect":
            obs_id = ver["observe"]
            obs = tools_by_id.get(obs_id)
            if not obs:
                errors.append(f"recovery.verify observe '{obs_id}' not declared")
            elif obs.get("read_only") is not True:
                errors.append(f"recovery observer '{obs_id}' must have read_only: true")
    return errors, warnings


def validate_agent(agent: dict[str, Any]) -> tuple[bool, list[str], list[str]]:
    warnings: list[str] = []
    try:
        canonical_json(agent.get("state") or {})
    except ValueError as e:
        return False, [str(e)], warnings
    schema = json.loads(_schema_path().read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema)
    schema_errors = [
        f"{'/'.join(str(p) for p in e.path)} {e.message}"
        for e in sorted(validator.iter_errors(agent), key=lambda e: list(e.path))
    ]
    struct_errors, struct_warnings = structural_checks(agent)
    warnings.extend(struct_warnings)
    errors = schema_errors + struct_errors
    return (len(errors) == 0), errors, warnings
