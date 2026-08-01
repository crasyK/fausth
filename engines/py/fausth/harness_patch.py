"""Mutable-cell harness patches (M16) — mirrors engines/ts/src/harness-patch.ts."""
from __future__ import annotations

import copy
import hashlib
from typing import Any

from .canonical import canonical_json

FORBIDDEN_OPS = {
    "set_permissions_tools",
    "set_sequences",
    "set_checkpoints",
    "set_tool_id",
    "set_tool_verify",
    "set_tool_input",
    "set_tool_output",
}

SKILLS_PATCH_DECLINE_REASONS = frozenset(
    {
        "no_new_heuristic",
        "insufficient_evidence",
        "would_overfit_task",
        "skills_already_adequate",
    }
)


def parse_harness_patch(args: dict[str, Any]) -> dict[str, Any] | None:
    ops = args.get("ops")
    if not isinstance(ops, list) or len(ops) == 0:
        return None
    if len(ops) > 1:
        return None
    return {"ops": ops}


def parse_skills_patch_decline(args: dict[str, Any]) -> dict[str, Any] | None:
    reason = args.get("reason")
    if not isinstance(reason, str) or reason not in SKILLS_PATCH_DECLINE_REASONS:
        return None
    note = args.get("note")
    if note is not None and not isinstance(note, str):
        return None
    out: dict[str, Any] = {"reason": reason}
    if isinstance(note, str):
        out["note"] = note
    return out


def parse_skills_reflect(args: dict[str, Any]) -> dict[str, Any] | None:
    """Unified end-of-phase skills reflection (`harness.reflect_skills`)."""
    disposition = args.get("disposition")
    if disposition == "decline":
        decline = parse_skills_patch_decline(args)
        if decline is None:
            return None
        return {"disposition": "decline", **decline}
    if disposition == "propose":
        patch = parse_harness_patch(args)
        if patch is None:
            return None
        return {"disposition": "propose", "patch": patch}
    return None


def _cell_allowed(mutable: list[str] | None, cell: str) -> bool:
    return cell in (mutable or [])


def validate_patch_security(agent: dict[str, Any], patch: dict[str, Any]) -> tuple[bool, str, str]:
    """Returns (ok, reason, error)."""
    ops = patch.get("ops") or []
    if not ops:
        return False, "harness_patch_invalid", "empty patch"
    tool_ids = {t["id"] for t in agent.get("tools") or []}
    mutable = agent.get("mutable")
    for op in ops:
        if not isinstance(op, dict) or "op" not in op:
            return False, "harness_patch_invalid", "malformed patch op"
        kind = op["op"]
        if kind in FORBIDDEN_OPS:
            return (
                False,
                "harness_patch_denied",
                f"op '{kind}' mutates immutable security/capability surface",
            )
        if kind == "set_tool_description":
            if not _cell_allowed(mutable, "skills"):
                return False, "harness_patch_denied", "skills not in mutable; cannot set_tool_description"
            tool_id = str(op.get("tool_id") or "")
            if tool_id not in tool_ids:
                return False, "harness_patch_invalid", f"unknown tool_id '{tool_id}'"
            if not isinstance(op.get("description"), str):
                return False, "harness_patch_invalid", "set_tool_description requires string description"
        elif kind == "set_memory_note":
            if not _cell_allowed(mutable, "memory"):
                return False, "harness_patch_denied", "memory not in mutable; cannot set_memory_note"
            if not str(op.get("key") or ""):
                return False, "harness_patch_invalid", "set_memory_note requires key"
            if not isinstance(op.get("note"), str):
                return False, "harness_patch_invalid", "set_memory_note requires string note"
        elif kind == "set_instinct_text":
            if not _cell_allowed(mutable, "instincts"):
                return False, "harness_patch_denied", "instincts not in mutable; cannot set_instinct_text"
            if not isinstance(op.get("text"), str):
                return False, "harness_patch_invalid", "set_instinct_text requires string text"
        else:
            return False, "harness_patch_invalid", f"unknown patch op '{kind}'"
    return True, "", ""


def harness_ir_hash(agent: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(agent).encode("utf-8")).hexdigest()


def apply_harness_patch(agent: dict[str, Any], patch: dict[str, Any]) -> None:
    for op in patch.get("ops") or []:
        kind = op["op"]
        if kind == "set_tool_description":
            for t in agent.get("tools") or []:
                if t.get("id") == op["tool_id"]:
                    t["description"] = op["description"]
                    break
        elif kind == "set_memory_note":
            cb = agent.setdefault("counterbalance", {})
            notes = cb.setdefault("memory_notes", {})
            notes[op["key"]] = op["note"]
        elif kind == "set_instinct_text":
            agent["instinct_text"] = op["text"]


def apply_candidate_patch(agent: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    clone = copy.deepcopy(agent)
    ok, reason, error = validate_patch_security(clone, patch)
    if not ok:
        raise ValueError(f"{reason}: {error}")
    apply_harness_patch(clone, patch)
    return clone
