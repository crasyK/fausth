"""Agent IR validation — Python twin of TS ``validate.ts``.

Schema location (PY-20) does not depend on the package's depth inside the
repository: ``$FAUSTH_SCHEMA_DIR`` → the repository ``schema/`` directory found
by walking up from this file → the copy shipped as package data
(``fausth/schema/``, kept identical by a drift test).
"""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from .canonical import UNDEFINED, canonical_json, jget, js_string, js_truthy, json_loads, nn, read_text_utf8
from .runtime import SandboxPathError, normalize_scope
from .schema_validate import FORMAT_CHECKER

CONTRACT_SCHEMA = "counterbalance-contract.v0.1.json"


class SchemaNotFound(FileNotFoundError):
    pass


def schema_dir_candidates() -> list[Path]:
    """Candidate directories holding the normative JSON schemas, in priority order."""
    out: list[Path] = []
    env = os.environ.get("FAUSTH_SCHEMA_DIR")
    if env:
        out.append(Path(env))
    here = Path(__file__).resolve()
    for parent in here.parents:
        cand = parent / "schema"
        if (cand / CONTRACT_SCHEMA).is_file() and (parent / "engines").is_dir():
            out.append(cand)
            break
    out.append(here.parent / "schema")
    return out


def schema_path(name: str = CONTRACT_SCHEMA) -> Path:
    for d in schema_dir_candidates():
        p = d / name
        if p.is_file():
            return p
    raise SchemaNotFound(
        f"schema {name} not found (searched {', '.join(str(d) for d in schema_dir_candidates())}); "
        "set FAUSTH_SCHEMA_DIR to the directory containing the fausth JSON schemas"
    )


def _schema_path() -> Path:  # backwards-compatible alias
    return schema_path()


@lru_cache(maxsize=8)
def _contract_validator(path: str) -> Draft202012Validator:
    schema = json_loads(read_text_utf8(path))
    return Draft202012Validator(schema, format_checker=FORMAT_CHECKER)


def _tool_ids(agent: dict[str, Any]) -> list[Any]:
    tools = agent.get("tools")
    return [jget(t, "id") for t in tools] if isinstance(tools, list) else []


def structural_checks(
    agent: dict[str, Any], *, provided_tools: frozenset[str] | set[str] = frozenset()
) -> tuple[list[str], list[str]]:
    """TS ``structuralChecks`` plus the SPEC-16 / D7 rules.

    ``provided_tools`` are tool ids a connector manifest provides at resolution
    time; they count as declared for the permissions allowlist check.
    """
    errors: list[str] = []
    warnings: list[str] = []
    if js_truthy(agent.get("safe_state")) and not js_truthy(agent.get("fallback_state")):
        warnings.append("safe_state is deprecated; use fallback_state")
    tools = agent.get("tools") if isinstance(agent.get("tools"), list) else []
    ids: list[Any] = []
    for t in tools:
        tid = jget(t, "id")
        if tid in ids:
            errors.append(f"Duplicate tool id: {js_string(tid)}")
        ids.append(tid)

    def find(tid: Any) -> Any:
        return next((x for x in tools if jget(x, "id") == tid), None)

    for t in tools:
        for v in nn(jget(t, "verify"), []) if isinstance(nn(jget(t, "verify"), []), list) else []:
            if jget(v, "kind") == "effect":
                observe = jget(v, "observe")
                obs = find(observe)
                if obs is None:
                    errors.append(f"Tool {js_string(jget(t, 'id'))}: effect observe '{js_string(observe)}' not declared")
                elif jget(obs, "read_only") is not True:
                    errors.append(
                        f"Tool {js_string(jget(t, 'id'))}: observer '{js_string(observe)}' must have read_only: true"
                    )
    recovery = agent.get("recovery", UNDEFINED)
    if js_truthy(recovery):
        rt = jget(jget(recovery, "execute"), "tool")
        if rt not in ids:
            errors.append(f"recovery.execute.tool '{js_string(rt)}' not declared")
        ver = jget(recovery, "verify")
        if jget(ver, "kind") == "effect":
            obs_id = jget(ver, "observe")
            obs = find(obs_id)
            if obs is None:
                errors.append(f"recovery.verify observe '{js_string(obs_id)}' not declared")
            elif jget(obs, "read_only") is not True:
                errors.append(f"recovery observer '{js_string(obs_id)}' must have read_only: true")
    mutable = agent.get("mutable", UNDEFINED)
    if js_truthy(mutable) and isinstance(mutable, list):
        for cell in mutable:
            if cell not in ("skills", "memory", "instincts"):
                errors.append(f"mutable cell '{js_string(cell)}' is not allowed (skills|memory|instincts only)")
    perms = agent.get("permissions", UNDEFINED)
    # SPEC-16: the capability allowlist may only name declared tools.
    perm_tools = jget(perms, "tools")
    if isinstance(perm_tools, list):
        for tid in perm_tools:
            if tid not in ids and tid not in provided_tools:
                errors.append(f"permissions.tools '{js_string(tid)}' not declared in tools")
    # D7: scopes must normalize to a relative path inside the workspace (root only as '.').
    fs = jget(perms, "filesystem")
    for key in ("write_scopes", "read_scopes"):
        scopes = jget(fs, key)
        if not isinstance(scopes, list):
            continue
        for sc in scopes:
            try:
                normalize_scope(sc)
            except SandboxPathError as e:
                errors.append(f"permissions.filesystem.{key} '{js_string(sc)}' {e.code}: {e}")
    return errors, warnings


def _error_path(e: Any) -> str:
    parts = list(e.path)
    return "".join(f"/{p}" for p in parts)


def validate_agent(
    agent: dict[str, Any], *, provided_tools: frozenset[str] | set[str] = frozenset()
) -> tuple[bool, list[str], list[str]]:
    """Returns (ok, errors, warnings) — TS ``validateAgent``."""
    warnings: list[str] = []
    validator = _contract_validator(str(schema_path()))
    if not isinstance(agent, dict):
        return False, ["agent IR must be a JSON object"], warnings
    try:
        canonical_json(agent.get("state", UNDEFINED))
    except ValueError as e:
        return False, [str(e)], warnings
    try:
        # D3: every value in the IR must be canonical (it can reach the event log).
        canonical_json(agent)
    except ValueError as e:
        return False, [f"non-canonical IR: {e}"], warnings
    schema_errors = [
        f"{_error_path(e)} {e.message}"
        for e in sorted(validator.iter_errors(agent), key=lambda e: [str(p) for p in e.path])
    ]
    struct_errors, struct_warnings = structural_checks(agent, provided_tools=provided_tools)
    warnings.extend(struct_warnings)
    errors = schema_errors + struct_errors
    return (len(errors) == 0), errors, warnings


def load_agent_for_validation(path: str | Path) -> dict[str, Any]:
    """TS ``validateAgentPath`` loading rules."""
    from .registry import agent_yaml_to_ir, load_yaml

    p = Path(path)
    if str(p).endswith(".json"):
        return json_loads(read_text_utf8(p))
    if (p / "agent.yml").exists():
        return agent_yaml_to_ir(load_yaml(p / "agent.yml"))
    if (p / "agent.json").exists():
        return json_loads(read_text_utf8(p / "agent.json"))
    if str(p).endswith((".yml", ".yaml")):
        return agent_yaml_to_ir(load_yaml(p))
    raise FileNotFoundError(f"Cannot find agent at {path}")


def connector_provided_tools(harness_dir: str | Path) -> set[str]:
    """Tool ids that the harness's connectors manifest adds at resolution time."""
    d = Path(harness_dir)
    if not any((d / n).is_file() for n in ("connectors.yml", "connectors.yaml", "connectors.json")):
        return set()
    from .connectors import resolve_harness

    resolved = resolve_harness(d)
    return {t["id"] for t in resolved["agent"].get("tools") or [] if isinstance(t, dict) and isinstance(t.get("id"), str)}


def validate_agent_path(path: str | Path) -> tuple[bool, dict[str, Any] | None, list[str], list[str]]:
    """Returns (ok, agent, errors, warnings)."""
    try:
        agent = load_agent_for_validation(path)
    except FileNotFoundError as e:
        return False, None, [str(e)], []
    provided = connector_provided_tools(path) if Path(path).is_dir() else set()
    ok, errors, warnings = validate_agent(agent, provided_tools=provided)
    return ok, (agent if ok else None), errors, warnings


__all__ = [
    "SchemaNotFound",
    "load_agent_for_validation",
    "schema_dir_candidates",
    "schema_path",
    "structural_checks",
    "validate_agent",
    "validate_agent_path",
]
