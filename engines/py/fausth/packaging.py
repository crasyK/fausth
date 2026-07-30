"""Harness packaging helpers (M7) — inspect / test / pack."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .canonical import canonical_json
from .registry import AdapterError, load_agent_dir, load_yaml, resolve_tools_from_deployment
from .runtime import FaustRuntime, events_to_jsonl, replay_fixture
from .connectors import ConnectorError, resolve_harness, resolved_harness_hash
from .bundle_signature import load_sign_key_from_path, sign_bundle

DEPLOYMENT_CANDIDATES = [
    "deployment.fixture.yml",
    "deployment.simulation.yml",
    "deployment.openrouter-free.yml",
    "deployment.kit.yml",
    "deployment.openai.yml",
    "deployment.ollama.yml",
]

LOCAL_DEPLOYMENT_PREFIX = "deployment.local"

PACK_INCLUDE = [
    "agent.yml",
    "agent.json",
    "README.md",
    "smoke.model.jsonl",
    "smoke.expected.jsonl",
    *DEPLOYMENT_CANDIDATES,
]

CONNECTOR_MANIFEST_NAMES = ("connectors.yml", "connectors.yaml", "connectors.json")


def is_local_only_deployment_file(name: str) -> bool:
    return name.startswith(LOCAL_DEPLOYMENT_PREFIX)


def list_deployments(harness_dir: Path) -> list[Path]:
    return [harness_dir / n for n in DEPLOYMENT_CANDIDATES if (harness_dir / n).is_file()]


def pick_test_deployment(harness_dir: Path, explicit: str | None = None) -> Path | None:
    if explicit:
        return Path(explicit).resolve()
    for n in ("deployment.fixture.yml", "deployment.simulation.yml"):
        p = harness_dir / n
        if p.is_file():
            return p
    for p in list_deployments(harness_dir):
        if not is_local_only_deployment_file(p.name):
            return p
    return None


def inspect_harness(
    harness_dir: str,
    *,
    embedded_resolved: dict[str, Any] | None = None,
    bundle_format: str | None = None,
) -> dict[str, Any]:
    d = Path(harness_dir).resolve()
    source_agent = load_agent_dir(str(d))
    agent = source_agent
    connectors_present = any(
        (d / name).is_file() for name in ("connectors.yml", "connectors.yaml", "connectors.json")
    )
    resolved: dict[str, Any] | None = None
    try:
        resolved = embedded_resolved if embedded_resolved is not None else resolve_harness(d)
        agent = resolved["agent"]
        resolution = {
            "connectors_file": connectors_present or embedded_resolved is not None,
            "connector_count": len(resolved["resolution"]["connectors"]),
            "kinds": sorted(
                {c["kind"] for c in resolved["resolution"]["connectors"]}
            ),
            "selected_count": len(resolved["resolution"]["selected"]),
            "lock_count": len(resolved["resolution"]["lock"]),
            "resolved_sha256": resolved_harness_hash(resolved),
            "ok": True,
        }
        if bundle_format:
            resolution["bundle_format"] = bundle_format
        if embedded_resolved is not None:
            resolution["embedded"] = True
    except ConnectorError as e:
        resolution = {
            "connectors_file": connectors_present,
            "connector_count": 0,
            "kinds": [],
            "selected_count": 0,
            "lock_count": 0,
            "resolved_sha256": "",
            "ok": False,
            "error": str(e),
        }
        if bundle_format:
            resolution["bundle_format"] = bundle_format
        resolved = None
    deployments = []
    seen: set[str] = set()
    for p in list_deployments(d):
        seen.add(p.name)
        dep = load_yaml(str(p))
        deployments.append(
            {
                "file": p.name,
                "platform": dep.get("platform"),
                "transport": (dep.get("model") or {}).get("transport"),
                "binding_count": len(dep.get("bindings") or {}),
            }
        )
    for p in sorted(d.glob("deployment.local*.y*ml")):
        if p.name in seen or not p.is_file():
            continue
        dep = load_yaml(str(p))
        deployments.append(
            {
                "file": p.name,
                "platform": dep.get("platform"),
                "transport": (dep.get("model") or {}).get("transport"),
                "binding_count": len(dep.get("bindings") or {}),
            }
        )
    report: dict[str, Any] = {
        "harness": d.name,
        "path": str(d),
        "name": agent.get("name"),
        "spec": agent.get("spec"),
        "tools": [t["id"] for t in agent.get("tools") or []],
        "permissions_tools": (agent.get("permissions") or {}).get("tools"),
        "sequences": [
            s.get("id") or s.get("action")
            for s in (agent.get("counterbalance") or {}).get("sequences") or []
        ],
        "spawn": agent.get("spawn"),
        "deployments": deployments,
        "smoke": {
            "model": (d / "smoke.model.jsonl").is_file(),
            "expected": (d / "smoke.expected.jsonl").is_file(),
        },
        "resolution": resolution,
    }
    dep_path = pick_test_deployment(d)
    if dep_path:
        try:
            resolve_tools_from_deployment(
                agent,
                load_yaml(str(dep_path)),
                harness_dir=str(d),
                resolved=resolved,
            )
            report["binding_coverage"] = {
                "deployment": dep_path.name,
                "missing": [],
                "ok": True,
            }
        except AdapterError as e:
            report["binding_coverage"] = {
                "deployment": dep_path.name,
                "missing": [],
                "ok": False,
                "error": str(e),
            }

    return report


def test_harness(
    harness_dir: str,
    *,
    deployment: str | None = None,
    skip_fixtures: bool = False,
    embedded_resolved: dict[str, Any] | None = None,
    bundle_format: str | None = None,
) -> dict[str, Any]:
    d = Path(harness_dir).resolve()
    errors: list[str] = []
    details: list[str] = []
    try:
        resolved = embedded_resolved if embedded_resolved is not None else resolve_harness(d)
        agent = resolved["agent"]
        if bundle_format:
            details.append(f"bundle {bundle_format}")
        if embedded_resolved is not None:
            details.append(
                f"embedded resolved OK (sha256={resolved_harness_hash(resolved)}, "
                f"{len(resolved['resolution']['connectors'])} connectors)"
            )
        else:
            details.append(
                f"resolve OK ({len(resolved['resolution']['connectors'])} connectors)"
            )
    except ConnectorError as e:
        return {
            "ok": False,
            "bindings_ok": False,
            "smoke_ok": None,
            "fixtures_ok": None,
            "errors": [str(e)],
            "details": details,
        }
    dep_path = pick_test_deployment(d, deployment)
    if not dep_path:
        return {
            "ok": False,
            "errors": ["no deployment found"],
            "details": details,
        }
    try:
        tools = resolve_tools_from_deployment(
            agent,
            load_yaml(str(dep_path)),
            harness_dir=str(d),
            resolved=resolved,
        )
        details.append(f"bindings OK ({dep_path.name})")
        bindings_ok = True
    except AdapterError as e:
        errors.append(str(e))
        bindings_ok = False
        tools = {}

    smoke_ok: bool | None = None
    model_path = d / "smoke.model.jsonl"
    expected_path = d / "smoke.expected.jsonl"
    if bindings_ok and model_path.is_file():
        proposals = [
            json.loads(line)
            for line in model_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        rt = FaustRuntime(agent, proposals, tools, None)
        rt.run_loop(32)
        actual = events_to_jsonl(rt.events)
        if not expected_path.is_file():
            smoke_ok = False
            errors.append("smoke.expected.jsonl missing")
        else:
            expected = expected_path.read_text(encoding="utf-8").replace("\r\n", "\n")
            smoke_ok = actual == expected
            details.append("smoke OK" if smoke_ok else "smoke mismatch")
            if not smoke_ok:
                errors.append("smoke event log ≠ smoke.expected.jsonl")
    elif not model_path.is_file():
        details.append("no smoke.model.jsonl (skipped)")

    fixtures_ok: bool | None = None
    if not skip_fixtures:
        root = d.parents[1] / "conformance" / "fixtures"
        prefixes: tuple[str, ...] = ()
        if d.name == "coding-counterbalance":
            prefixes = (
                "cb-coding-",
                "cb-write-",
                "cb-stale-",
                "cb-completion-",
                "cb-user-",
            )
        elif d.name == "support-bot":
            prefixes = ("cb-support-",)
        if prefixes and root.is_dir():
            fixtures_ok = True
            for child in sorted(root.iterdir()):
                if child.is_dir() and child.name.startswith(prefixes):
                    ok, _, _ = replay_fixture(child)
                    details.append(f"{'PASS' if ok else 'FAIL'} fixture {child.name}")
                    if not ok:
                        fixtures_ok = False
                        errors.append(f"fixture {child.name} mismatch")

    ok = bindings_ok and (smoke_ok is None or smoke_ok) and (fixtures_ok is None or fixtures_ok)
    return {
        "ok": ok,
        "bindings_ok": bindings_ok,
        "smoke_ok": smoke_ok,
        "fixtures_ok": fixtures_ok,
        "errors": errors,
        "details": details,
    }


def pack_harness(
    harness_dir: str,
    out: str | None = None,
    *,
    sign_key: str | None = None,
) -> dict[str, Any]:
    d = Path(harness_dir).resolve()
    files: dict[str, str] = {}
    for n in PACK_INCLUDE:
        p = d / n
        if p.is_file():
            files[n] = p.read_text(encoding="utf-8")
    for p in sorted(d.iterdir()):
        if (
            p.is_file()
            and p.name.startswith("deployment.")
            and p.suffix.lower() in (".yml", ".yaml")
            and p.name not in files
        ):
            files[p.name] = p.read_text(encoding="utf-8")

    has_connectors = any((d / name).is_file() for name in CONNECTOR_MANIFEST_NAMES)
    recorded = d / "mcp.recorded.jsonl"
    if recorded.is_file():
        files["mcp.recorded.jsonl"] = recorded.read_text(encoding="utf-8")

    if has_connectors:
        resolved = resolve_harness(d)
        has_mcp = any(lock.get("kind") == "mcp" for lock in resolved["resolution"]["lock"])
        for name in CONNECTOR_MANIFEST_NAMES:
            p = d / name
            if p.is_file():
                files[name] = p.read_text(encoding="utf-8")
        for lock in resolved["resolution"]["lock"]:
            if lock.get("kind") not in ("file", "mcp"):
                continue
            path = lock.get("path")
            if not path:
                continue
            p = d / path
            if not p.is_file():
                raise ConnectorError(
                    "connector_import_not_found",
                    f"pack: lock path missing on disk: {path}",
                )
            if path not in files:
                files[path] = p.read_text(encoding="utf-8")
        ordered = {k: files[k] for k in sorted(files.keys())}
        bundle: dict[str, Any] = {
            "format": (
                "fausth-harness-bundle/v0.3" if has_mcp else "fausth-harness-bundle/v0.2"
            ),
            "name": d.name,
            "files": ordered,
            "resolved": resolved,
            "resolved_sha256": resolved_harness_hash(resolved),
        }
    else:
        ordered = {k: files[k] for k in sorted(files.keys())}
        bundle = {
            "format": "fausth-harness-bundle/v0.1",
            "name": d.name,
            "files": ordered,
        }

    key_path = sign_key if sign_key is not None else os.environ.get("FAUSTH_SIGN_KEY")
    signed = False
    if key_path:
        bundle = sign_bundle(bundle, load_sign_key_from_path(key_path))
        signed = True

    if out and out.endswith(".fausth.json"):
        out_path = Path(out).resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
    else:
        out_dir = Path(out).resolve() if out else d / "dist"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{d.name}.fausth.json"
    out_path.write_text(canonical_json(bundle) + "\n", encoding="utf-8", newline="\n")
    return {
        "out": str(out_path),
        "files": sorted(ordered.keys()),
        "format": bundle["format"],
        "signed": signed,
    }
