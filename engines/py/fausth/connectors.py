"""Deterministic connector resolution (M10).

Compile/link sidecar manifests into ResolvedHarnessIR without network access
or module execution.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

import yaml

from .canonical import canonical_json
from .registry import load_agent_dir

CONNECTORS_FORMAT = "fausth-connectors/v0.1"
CONNECTOR_MANIFEST_FORMAT = "fausth-connector-manifest/v0.1"
RESOLVED_HARNESS_FORMAT = "fausth-resolved-harness/v0.1"

SECRET_KEY_RE = re.compile(r"(api[_-]?key|secret|password|token|credential|authorization)", re.I)


class ConnectorError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def sha256_hex(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def assert_no_secrets(value: Any, path: str) -> None:
    if isinstance(value, list):
        for i, v in enumerate(value):
            assert_no_secrets(v, f"{path}[{i}]")
        return
    if isinstance(value, dict):
        for k, v in value.items():
            if SECRET_KEY_RE.search(str(k)):
                raise ConnectorError(
                    "connectors_secret",
                    f"forbidden secret-like key '{k}' at {path}.{k}",
                )
            assert_no_secrets(v, f"{path}.{k}")


def assert_safe_relative_path(rel_path: str) -> None:
    if not rel_path or not isinstance(rel_path, str):
        raise ConnectorError("connectors_path", "empty connector path")
    if "\0" in rel_path:
        raise ConnectorError("connectors_path", "connector path contains NUL")
    p = Path(rel_path)
    if p.is_absolute() or re.match(r"^[a-zA-Z]:", rel_path) or rel_path.startswith("~"):
        raise ConnectorError("connectors_path", f"absolute connector path forbidden: {rel_path}")
    parts = Path(rel_path.replace("\\", "/")).parts
    if ".." in parts:
        raise ConnectorError("connectors_path", f"path traversal forbidden: {rel_path}")


def resolve_under_harness(harness_dir: Path, rel_path: str) -> tuple[Path, str]:
    assert_safe_relative_path(rel_path)
    root_real = harness_dir.resolve()
    abs_path = (harness_dir / rel_path).resolve()
    if not abs_path.is_file():
        raise ConnectorError("connectors_path", f"connector file not found: {rel_path}")
    try:
        abs_path.relative_to(root_real)
    except ValueError as e:
        raise ConnectorError(
            "connectors_path",
            f"connector path escapes harness root: {rel_path}",
        ) from e
    rel = abs_path.relative_to(root_real).as_posix()
    return abs_path, rel


def load_yaml_or_json(path: Path) -> Any:
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json":
        return json.loads(text)
    return yaml.safe_load(text)


def as_provision(raw: Any, path: str) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ConnectorError("connectors_invalid", f"{path} must be an object")
    assert_no_secrets(raw, path)
    pid = raw.get("id")
    if not isinstance(pid, str) or not pid:
        raise ConnectorError("connectors_invalid", f"{path}.id must be a non-empty string")
    out: dict[str, Any] = {"id": pid}
    if "description" in raw:
        out["description"] = str(raw["description"])
    if "read_only" in raw:
        out["read_only"] = bool(raw["read_only"])
    if "input" in raw:
        out["input"] = raw["input"]
    if "output" in raw:
        out["output"] = raw["output"]
    if "verify" in raw:
        out["verify"] = raw["verify"]
    return out


def provision_to_tool(p: dict[str, Any]) -> dict[str, Any]:
    t: dict[str, Any] = {"id": p["id"]}
    for key in ("description", "read_only", "input", "output", "verify"):
        if key in p:
            t[key] = p[key]
    return t


def load_file_manifest(harness_dir: Path, connector: dict[str, Any]) -> dict[str, Any]:
    abs_path, rel = resolve_under_harness(harness_dir, connector["path"])
    content = abs_path.read_text(encoding="utf-8")
    digest = sha256_hex(content)
    if "sha256" in connector and connector["sha256"] is not None:
        expected = str(connector["sha256"])
        if not re.fullmatch(r"[a-f0-9]{64}", expected):
            raise ConnectorError(
                "connectors_invalid",
                f"connector '{connector['id']}' sha256 must be a 64-char lowercase hex string",
            )
        if expected != digest:
            raise ConnectorError(
                "connectors_hash_mismatch",
                f"sha256 mismatch for connector '{connector['id']}' at {rel}: "
                f"expected {expected}, got {digest}",
            )
    raw = json.loads(content) if abs_path.suffix.lower() == ".json" else yaml.safe_load(content)
    if not isinstance(raw, dict):
        raise ConnectorError("connectors_invalid", f"manifest at {rel} must be an object")
    if raw.get("format") != CONNECTOR_MANIFEST_FORMAT:
        raise ConnectorError(
            "connectors_unsupported",
            f"unsupported connector manifest format at {rel}: {raw.get('format')!r}",
        )
    assert_no_secrets(raw, f"file:{rel}")
    provides_raw = raw.get("provides")
    if not isinstance(provides_raw, list) or not provides_raw:
        raise ConnectorError("connectors_invalid", f"manifest at {rel} requires provides[]")
    provides = [as_provision(p, f"file:{rel}.provides[{i}]") for i, p in enumerate(provides_raw)]
    return {"provides": provides, "sha256": digest, "path": rel}


def load_connectors_file(harness_dir: Path) -> dict[str, Any] | None:
    for name in ("connectors.yml", "connectors.yaml", "connectors.json"):
        p = harness_dir / name
        if not p.is_file():
            continue
        raw = load_yaml_or_json(p)
        if not isinstance(raw, dict):
            raise ConnectorError("connectors_invalid", f"{name} must be an object")
        if raw.get("format") != CONNECTORS_FORMAT:
            raise ConnectorError(
                "connectors_unsupported",
                f"unsupported connectors format: {raw.get('format')!r}",
            )
        assert_no_secrets(raw, name)
        if not isinstance(raw.get("connectors"), list):
            raise ConnectorError("connectors_invalid", f"{name}.connectors must be an array")
        return raw
    return None


def select_provides(
    connector_id: str,
    provides: list[dict[str, Any]],
    select: list[str] | None,
) -> list[dict[str, Any]]:
    ids = [p["id"] for p in provides]
    for i, pid in enumerate(ids):
        if ids.index(pid) != i:
            raise ConnectorError(
                "connectors_duplicate",
                f"duplicate provision id '{pid}' in connector '{connector_id}'",
            )
    if select is None:
        return list(provides)
    by_id = {p["id"]: p for p in provides}
    out: list[dict[str, Any]] = []
    for pid in select:
        hit = by_id.get(pid)
        if hit is None:
            raise ConnectorError(
                "connectors_unknown_select",
                f"connector '{connector_id}' select unknown provision '{pid}'",
            )
        out.append(hit)
    return out


def merge_tools(agent: dict[str, Any], selected: list[dict[str, Any]]) -> dict[str, Any]:
    tools = list(agent.get("tools") or [])
    by_id = {t["id"]: t for t in tools}
    for p in selected:
        tool = provision_to_tool(p)
        existing = by_id.get(tool["id"])
        if existing is not None:
            if canonical_json(existing) != canonical_json(tool):
                raise ConnectorError(
                    "connectors_duplicate",
                    f"provision '{tool['id']}' conflicts with existing agent tool definition",
                )
            continue
        tools.append(tool)
        by_id[tool["id"]] = tool
    out = dict(agent)
    out["tools"] = tools
    return out


def empty_resolution() -> dict[str, Any]:
    return {"connectors": [], "selected": [], "lock": []}


def resolve_harness(harness_dir: str | Path) -> dict[str, Any]:
    d = Path(harness_dir).resolve()
    agent = load_agent_dir(str(d))
    source = load_connectors_file(d)
    if source is None:
        return {
            "format": RESOLVED_HARNESS_FORMAT,
            "agent": agent,
            "resolution": empty_resolution(),
        }

    connector_ids: set[str] = set()
    entries: list[dict[str, Any]] = []
    lock: list[dict[str, Any]] = []
    selected_provisions: list[dict[str, Any]] = []
    selected_ids: list[str] = []
    selected_seen: set[str] = set()

    for raw in source["connectors"]:
        if not isinstance(raw, dict):
            raise ConnectorError("connectors_invalid", "connector entry must be an object")
        cid = raw.get("id")
        if not isinstance(cid, str) or not cid:
            raise ConnectorError("connectors_invalid", "connector.id must be a non-empty string")
        if cid in connector_ids:
            raise ConnectorError("connectors_duplicate", f"duplicate connector id '{cid}'")
        connector_ids.add(cid)
        kind = raw.get("kind")

        if kind == "inline":
            assert_no_secrets(raw, f"connector:{cid}")
            provides_raw = raw.get("provides")
            if not isinstance(provides_raw, list) or not provides_raw:
                raise ConnectorError(
                    "connectors_invalid",
                    f"inline connector '{cid}' requires provides[]",
                )
            provides = [
                as_provision(p, f"connector:{cid}.provides[{i}]")
                for i, p in enumerate(provides_raw)
            ]
            selected = select_provides(cid, provides, raw.get("select"))
            digest = sha256_hex(canonical_json({"kind": "inline", "provides": provides}))
            entries.append(
                {
                    "id": cid,
                    "kind": "inline",
                    "sha256": digest,
                    "provides": sorted(p["id"] for p in provides),
                    "selected": sorted(p["id"] for p in selected),
                }
            )
            lock.append({"connector": cid, "kind": "inline", "sha256": digest})
            for p in selected:
                if p["id"] in selected_seen:
                    raise ConnectorError(
                        "connectors_duplicate",
                        f"selected provision '{p['id']}' provided by multiple connectors",
                    )
                selected_seen.add(p["id"])
                selected_provisions.append(p)
                selected_ids.append(p["id"])
            continue

        if kind == "file":
            assert_no_secrets(raw, f"connector:{cid}")
            if not isinstance(raw.get("path"), str) or not raw.get("path"):
                raise ConnectorError(
                    "connectors_invalid",
                    f"file connector '{cid}' requires path",
                )
            loaded = load_file_manifest(d, raw)
            selected = select_provides(cid, loaded["provides"], raw.get("select"))
            entries.append(
                {
                    "id": cid,
                    "kind": "file",
                    "path": loaded["path"],
                    "sha256": loaded["sha256"],
                    "provides": sorted(p["id"] for p in loaded["provides"]),
                    "selected": sorted(p["id"] for p in selected),
                }
            )
            lock.append(
                {
                    "connector": cid,
                    "kind": "file",
                    "path": loaded["path"],
                    "sha256": loaded["sha256"],
                }
            )
            for p in selected:
                if p["id"] in selected_seen:
                    raise ConnectorError(
                        "connectors_duplicate",
                        f"selected provision '{p['id']}' provided by multiple connectors",
                    )
                selected_seen.add(p["id"])
                selected_provisions.append(p)
                selected_ids.append(p["id"])
            continue

        raise ConnectorError(
            "connectors_unsupported",
            f"unsupported connector kind '{kind}' (M10 supports inline|file only)",
        )

    entries.sort(key=lambda e: e["id"])
    lock.sort(key=lambda e: e["connector"])
    selected_ids.sort()
    merged = merge_tools(agent, selected_provisions)
    return {
        "format": RESOLVED_HARNESS_FORMAT,
        "agent": merged,
        "resolution": {
            "connectors": entries,
            "selected": selected_ids,
            "lock": lock,
        },
    }


def resolved_harness_canonical_json(resolved: dict[str, Any]) -> str:
    return canonical_json(resolved) + "\n"


def resolved_harness_hash(resolved: dict[str, Any]) -> str:
    return sha256_hex(canonical_json(resolved))
