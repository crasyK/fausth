"""Harness packaging helpers (M7) — inspect / test / pack."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .canonical import canonical_json
from .registry import AdapterError, load_agent_dir, load_yaml, resolve_tools_from_deployment
from .runtime import FaustRuntime, events_to_jsonl, replay_fixture
from .connectors import ConnectorError, resolve_harness, resolved_harness_hash

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


def inspect_harness(harness_dir: str) -> dict[str, Any]:
    d = Path(harness_dir).resolve()
    source_agent = load_agent_dir(str(d))
    agent = source_agent
    connectors_present = any(
        (d / name).is_file() for name in ("connectors.yml", "connectors.yaml", "connectors.json")
    )
    try:
        resolved = resolve_harness(d)
        agent = resolved["agent"]
        resolution = {
            "connectors_file": connectors_present,
            "connector_count": len(resolved["resolution"]["connectors"]),
            "kinds": sorted(
                {c["kind"] for c in resolved["resolution"]["connectors"]}
            ),
            "selected_count": len(resolved["resolution"]["selected"]),
            "lock_count": len(resolved["resolution"]["lock"]),
            "resolved_sha256": resolved_harness_hash(resolved),
            "ok": True,
        }
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
        "modes": [m.get("id") for m in (agent.get("counterbalance") or {}).get("modes") or []],
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
            resolve_tools_from_deployment(agent, load_yaml(str(dep_path)))
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
) -> dict[str, Any]:
    d = Path(harness_dir).resolve()
    errors: list[str] = []
    details: list[str] = []
    try:
        resolved = resolve_harness(d)
        agent = resolved["agent"]
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
        tools = resolve_tools_from_deployment(agent, load_yaml(str(dep_path)))
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


def pack_harness(harness_dir: str, out: str | None = None) -> dict[str, Any]:
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
    ordered = {k: files[k] for k in sorted(files.keys())}
    bundle = {
        "format": "fausth-harness-bundle/v0.1",
        "name": d.name,
        "files": ordered,
    }
    if out and out.endswith(".fausth.json"):
        out_path = Path(out).resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
    else:
        out_dir = Path(out).resolve() if out else d / "dist"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{d.name}.fausth.json"
    out_path.write_text(canonical_json(bundle) + "\n", encoding="utf-8", newline="\n")
    return {"out": str(out_path), "files": sorted(ordered.keys())}
