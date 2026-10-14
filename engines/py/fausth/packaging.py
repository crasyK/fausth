"""Harness packaging helpers (M7) — inspect / test / pack."""
from __future__ import annotations

import copy
import json
import os
import re
from pathlib import Path
from typing import Any

from .canonical import canonical_json, read_jsonl, read_text_utf8
from .registry import AdapterError, load_agent_dir, load_yaml, resolve_tools_from_deployment
from .validate import validate_agent
from .runtime import FaustRuntime, default_tools, events_to_jsonl, replay_fixture
from .connectors import ConnectorError, decode_utf8_strict, resolve_harness, resolved_harness_hash
from .bundle_signature import load_sign_key_from_path, sign_bundle
from .bundle import (
    BUNDLE_FORMAT_V01,
    BUNDLE_FORMAT_V02,
    BUNDLE_FORMAT_V03,
    BundleError,
    assert_loadable_bundle,
)

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
    # Recorded user-channel answers (D14) — same list as TS packaging.ts (pack byte parity).
    "user.answers.jsonl",
    *DEPLOYMENT_CANDIDATES,
]

CONNECTOR_MANIFEST_NAMES = ("connectors.yml", "connectors.yaml", "connectors.json")

#: Recorded host fixtures that only the v0.3 allowlist admits.
V03_RECORDED_EXTRAS = ("mcp.recorded.jsonl", "module.recorded.jsonl")


def fixture_prefixes_for_harness(harness_name: str) -> tuple[str, ...]:
    """Track A fixture families per reference harness (mirrors TS fixturePrefixesForHarness)."""
    if harness_name == "coding-counterbalance":
        return (
            "cb-coding-",
            "cb-write-",
            "cb-stale-",
            "cb-completion-",
            "cb-user-",
            "cb-harness-patch-",
        )
    if harness_name == "mutable-skills":
        return ("cb-harness-patch-",)
    if harness_name == "support-bot":
        return ("cb-support-",)
    if harness_name == "coding":
        return ("code-", "spawn-")
    if harness_name == "greenhouse":
        return ("allow-", "deny-", "verify-", "budget-", "predicate-", "input-")
    return ()


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
        "deployments": deployments,
        "smoke": {
            "model": (d / "smoke.model.jsonl").is_file(),
            "expected": (d / "smoke.expected.jsonl").is_file(),
        },
        "resolution": resolution,
    }
    # Mirror TS inspectHarness: optional IR facts are omitted when undefined (never null).
    permissions = agent.get("permissions") if isinstance(agent.get("permissions"), dict) else {}
    if "tools" in permissions and permissions["tools"] is not None:
        report["permissions_tools"] = permissions["tools"]
    counterbalance = agent.get("counterbalance") if isinstance(agent.get("counterbalance"), dict) else {}
    if counterbalance.get("sequences") is not None:
        report["sequences"] = [
            s.get("id") if s.get("id") is not None else s.get("action")
            for s in counterbalance["sequences"]
        ]
    if agent.get("mutable") is not None:
        report["mutable"] = agent["mutable"]
    if agent.get("spawn") is not None:
        report["spawn"] = agent["spawn"]
    dep_path = pick_test_deployment(d)
    if dep_path:
        try:
            with resolve_tools_from_deployment(
                agent,
                load_yaml(str(dep_path)),
                harness_dir=str(d),
                resolved=resolved,
                deployment_path=str(dep_path),
            ):
                pass
            report["binding_coverage"] = {
                "deployment": dep_path.name,
                "missing": [],
                "ok": True,
            }
        except Exception as e:  # TS reports every binding failure, not only AdapterError
            missing: list[str] = []
            if isinstance(e, AdapterError) and e.code == "binding_missing":
                m = re.search(r"tool '([^']+)'", str(e))
                if m:
                    missing.append(m.group(1))
            report["binding_coverage"] = {
                "deployment": dep_path.name,
                "missing": missing,
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
    except Exception as e:  # TS: any resolve/load failure is a test failure, not a crash
        return {
            "ok": False,
            "validate_ok": False,
            "bindings_ok": False,
            "smoke_ok": None,
            "fixtures_ok": None,
            "errors": [str(e)],
            "details": [],
        }
    # Mirror TS testHarness: the resolved IR must validate before anything runs.
    validate_ok, validate_errors, validate_warnings = validate_agent(agent)
    if not validate_ok:
        return {
            "ok": False,
            "validate_ok": False,
            "bindings_ok": False,
            "smoke_ok": None,
            "fixtures_ok": None,
            "errors": list(validate_errors),
            "details": details,
        }
    details.append("validate OK")
    details.extend(f"warn: {w}" for w in validate_warnings)
    dep_path = pick_test_deployment(d, deployment)
    if not dep_path:
        return {
            "ok": False,
            "validate_ok": True,
            "bindings_ok": False,
            "smoke_ok": None,
            "fixtures_ok": None,
            "errors": ["no deployment found for harness test (need fixture/simulation or --deployment)"],
            "details": details,
        }
    deployment_doc = load_yaml(str(dep_path))
    bindings_ok = True
    try:
        # Binding check only; the smoke run binds its own (closed) tool set.
        with resolve_tools_from_deployment(
            agent,
            deployment_doc,
            harness_dir=str(d),
            resolved=resolved,
            deployment_path=str(dep_path),
        ):
            pass
        details.append(f"bindings OK ({dep_path.name})")
    except Exception as e:  # TS reports every binding failure, not only AdapterError
        errors.append(str(e))
        bindings_ok = False

    smoke_ok: bool | None = None
    model_path = d / "smoke.model.jsonl"
    expected_path = d / "smoke.expected.jsonl"
    if bindings_ok and model_path.is_file():
        try:
            with resolve_tools_from_deployment(
                agent,
                deployment_doc,
                harness_dir=str(d),
                resolved=resolved,
                deployment_path=str(dep_path),
            ) as tools:
                rt = FaustRuntime(agent, read_jsonl(model_path), tools, None)
                rt.run_loop(32)
            actual = events_to_jsonl(rt.events)
            if not expected_path.is_file():
                smoke_ok = False
                errors.append("smoke.model.jsonl present but smoke.expected.jsonl missing")
            else:
                expected = read_text_utf8(expected_path).replace("\r\n", "\n")
                smoke_ok = actual == expected
                details.append("smoke OK" if smoke_ok else "smoke mismatch")
                if not smoke_ok:
                    errors.append("smoke event log ≠ smoke.expected.jsonl")
        except Exception as e:
            smoke_ok = False
            errors.append(str(e))
    elif not model_path.is_file():
        details.append("no smoke.model.jsonl (skipped)")

    fixtures_ok: bool | None = None
    if not skip_fixtures:
        root = d.parents[1] / "conformance" / "fixtures"
        prefixes = fixture_prefixes_for_harness(d.name)
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
        "validate_ok": True,
        "bindings_ok": bindings_ok,
        "smoke_ok": smoke_ok,
        "fixtures_ok": fixtures_ok,
        "errors": errors,
        "details": details,
    }


def _read_pack_text(path: Path, rel: str) -> str:
    """Raw bytes → strict UTF-8 text (CRLF/BOM preserved exactly; invalid UTF-8 refused)."""
    text = decode_utf8_strict(path.read_bytes())
    if text is None:
        raise BundleError("bundle_invalid", f"pack: file is not valid UTF-8: {rel}")
    return text


def pack_harness(
    harness_dir: str,
    out: str | None = None,
    *,
    sign_key: str | None = None,
) -> dict[str, Any]:
    """Pack a harness; the packed object passes the loader's own validation before it is
    written, so pack never emits a bundle that load/verify rejects (mirrors TS)."""
    d = Path(harness_dir).resolve()
    files: dict[str, str] = {}
    for n in PACK_INCLUDE:
        p = d / n
        if p.is_file():
            files[n] = _read_pack_text(p, n)
    for p in sorted(d.iterdir()):
        if (
            p.is_file()
            and p.name.startswith("deployment.")
            and p.suffix.lower() in (".yml", ".yaml")
            and p.name not in files
        ):
            files[p.name] = _read_pack_text(p, p.name)

    has_connectors = any((d / name).is_file() for name in CONNECTOR_MANIFEST_NAMES)

    if has_connectors:
        resolved = resolve_harness(d)
        v03 = any(
            lock.get("kind") in ("mcp", "module") for lock in resolved["resolution"]["lock"]
        )
        for name in CONNECTOR_MANIFEST_NAMES:
            p = d / name
            if p.is_file():
                files[name] = _read_pack_text(p, name)
        for lock in resolved["resolution"]["lock"]:
            if lock.get("kind") not in ("file", "mcp", "module"):
                continue
            path = lock.get("path")
            if not path:
                continue
            p = d / path
            if not p.is_file():
                raise ConnectorError(
                    "connectors_path",
                    f"pack: lock path missing on disk: {path}",
                )
            if path not in files:
                files[path] = _read_pack_text(p, path)
        if v03:
            # Recorded host fixtures for Track A packs — only v0.3 admits them.
            for extra in V03_RECORDED_EXTRAS:
                p = d / extra
                if p.is_file() and extra not in files:
                    files[extra] = _read_pack_text(p, extra)
        ordered = {k: files[k] for k in sorted(files.keys())}
        bundle: dict[str, Any] = {
            "format": BUNDLE_FORMAT_V03 if v03 else BUNDLE_FORMAT_V02,
            "name": d.name,
            "files": ordered,
            "resolved": resolved,
            "resolved_sha256": resolved_harness_hash(resolved),
        }
    else:
        ordered = {k: files[k] for k in sorted(files.keys())}
        bundle = {
            "format": BUNDLE_FORMAT_V01,
            "name": d.name,
            "files": ordered,
        }

    # Same rules as load/verify (entry allowlist, limits, lock pins, re-resolution).
    assert_loadable_bundle(bundle)

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
    out_path.write_bytes((canonical_json(bundle) + "\n").encode("utf-8"))
    return {
        "out": str(out_path),
        "files": sorted(ordered.keys()),
        "format": bundle["format"],
        "signed": signed,
    }


# ---------------------------------------------------------------------------
# Selection gate (M16): "self-learning without gates is mutation without selection".
# Mirrors engines/ts/src/packaging.ts selectHarness.
# ---------------------------------------------------------------------------

TRANSCRIPT_MISMATCH = "Recorded transcript mismatch"


def _security_projection(agent: dict[str, Any]) -> dict[str, Any]:
    clone = copy.deepcopy(agent)
    clone["tools"] = [
        {k: v for k, v in t.items() if k != "description"} for t in clone.get("tools") or []
    ]
    cb = clone.get("counterbalance")
    if isinstance(cb, dict):
        clone["counterbalance"] = {k: v for k, v in cb.items() if k != "memory_notes"}
    clone.pop("instinct_text", None)
    return clone


def security_cell_changes(before: dict[str, Any], after: dict[str, Any]) -> list[str]:
    """Refuse any IR change outside the declared mutable cells (independent of
    harness_patch's own op validation)."""
    changes: list[str] = []
    a = _security_projection(before)
    b = _security_projection(after)
    for k in sorted(set(a) | set(b)):
        if canonical_json(a.get(k)) != canonical_json(b.get(k)):
            changes.append(f"security cell changed: {k}")
    mutable = set(before.get("mutable") or [])
    desc_before = canonical_json([[t.get("id"), t.get("description")] for t in before.get("tools") or []])
    desc_after = canonical_json([[t.get("id"), t.get("description")] for t in after.get("tools") or []])
    if desc_before != desc_after and "skills" not in mutable:
        changes.append("cell not mutable: skills (tool descriptions changed)")
    notes_before = canonical_json((before.get("counterbalance") or {}).get("memory_notes"))
    notes_after = canonical_json((after.get("counterbalance") or {}).get("memory_notes"))
    if notes_before != notes_after and "memory" not in mutable:
        changes.append("cell not mutable: memory (memory_notes changed)")
    if before.get("instinct_text") != after.get("instinct_text") and "instincts" not in mutable:
        changes.append("cell not mutable: instincts (instinct_text changed)")
    return changes


def transcript_outcome(agent: dict[str, Any], events: list[dict[str, Any]]) -> dict[str, Any]:
    """Governed outcome of an event log (mirrors TS transcriptOutcome)."""
    denies: dict[str, int] = {}
    error: str | None = None
    completion_tool = ((agent.get("counterbalance") or {}).get("completion") or {}).get("tool")
    completed: bool | None = False if completion_tool else None
    pending: dict[str, Any] = {"tool": None, "ok": False}

    def settle() -> None:
        nonlocal completed
        if pending["tool"] and pending["ok"] and completion_tool and pending["tool"] == completion_tool:
            completed = True
        pending["tool"] = None
        pending["ok"] = False

    for e in events:
        stage = e.get("stage")
        verdict = e.get("verdict")
        if stage in ("propose", "orient"):
            settle()
        if verdict in ("deny", "safe_state"):
            key = f"{verdict}|{stage}|{e.get('tool') or ''}|{e.get('reason') or ''}"
            denies[key] = denies.get(key, 0) + 1
        err = e.get("error")
        if error is None and isinstance(err, str) and err.startswith(TRANSCRIPT_MISMATCH):
            error = f"recorded transcript diverged at seq {e.get('seq')}"
        if stage == "execute":
            settle()
            if verdict == "allow" and e.get("tool"):
                pending["tool"] = e.get("tool")
                pending["ok"] = True
        elif stage == "verify" and pending["tool"] and verdict and verdict != "allow":
            pending["ok"] = False
    settle()
    out: dict[str, Any] = {"completed": completed, "denies": {k: denies[k] for k in sorted(denies)}}
    if error is not None:
        out["error"] = error
    return out


def _run_agent_on_transcript(
    agent: dict[str, Any],
    proposals: list[dict[str, Any]],
    recorded: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], str | None]:
    rt = FaustRuntime(agent, proposals, default_tools(agent), copy.deepcopy(recorded) or None)
    try:
        rt.run_loop()
        return rt.events, None
    except Exception as e:  # report, never crash the selection gate
        return rt.events, str(e)


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [
        json.loads(line)
        for line in path.read_bytes().decode("utf-8").splitlines()
        if line.strip()
    ]


def evaluate_fixture_fitness(
    fixture_dir: Path,
    baseline_agent: dict[str, Any],
    candidate_agent: dict[str, Any],
) -> dict[str, Any]:
    """Candidate fitness on one recorded transcript vs the unpatched baseline."""
    golden_ok, _, _ = replay_fixture(fixture_dir)
    proposals = _read_jsonl(fixture_dir / "model.jsonl")
    tools_path = fixture_dir / "tools.jsonl"
    recorded = _read_jsonl(tools_path) if tools_path.is_file() else []
    base_events, base_err = _run_agent_on_transcript(baseline_agent, proposals, recorded)
    cand_events, cand_err = _run_agent_on_transcript(candidate_agent, proposals, recorded)
    baseline = transcript_outcome(baseline_agent, base_events)
    if base_err:
        baseline["error"] = base_err
    candidate = transcript_outcome(candidate_agent, cand_events)
    if cand_err:
        candidate["error"] = cand_err
    replayable = "error" not in baseline
    reasons: list[str] = []
    if replayable:
        if "error" in candidate:
            reasons.append(f"candidate did not replay: {candidate['error']}")
        for key, n in baseline["denies"].items():
            got = candidate["denies"].get(key, 0)
            if got < n:
                reasons.append(f"lost {n - got}× {key}")
        if baseline["completed"] is True and candidate["completed"] is not True:
            reasons.append("lost completion")
    return {
        "fixture": fixture_dir.name,
        "golden_ok": golden_ok,
        "replayable": replayable,
        "baseline": baseline,
        "candidate": candidate,
        "candidate_pass": (not reasons) if replayable else None,
        "reasons": reasons,
    }


def _empty_fitness() -> dict[str, int]:
    return {"fixtures": 0, "replayable": 0, "candidate_passed": 0, "candidate_failed": 0}


def select_harness(
    harness_dir: str,
    patch: dict[str, Any],
    *,
    fixtures_root: str | None = None,
    skip_fixtures: bool = False,
) -> dict[str, Any]:
    """Selection gate (mirrors TS selectHarness): patch validation, security-cell diff,
    then baseline vs candidate on each matching fixture's recorded transcript."""
    from .harness_patch import apply_candidate_patch, harness_ir_hash

    d = Path(harness_dir).resolve()
    agent = load_agent_dir(str(d))
    before = harness_ir_hash(agent)
    details: list[str] = []
    errors: list[str] = []

    def result(**kw: Any) -> dict[str, Any]:
        base: dict[str, Any] = {
            "ok": False,
            "harness_hash_before": before,
            "harness_hash_after": before,
            "fixtures_ok": False,
            "security_ok": False,
            "security_changes": [],
            "fitness_evaluated": False,
            "fitness": _empty_fitness(),
            "fixtures": [],
            "details": details,
            "errors": errors,
            "patched_agent": None,
        }
        base.update(kw)
        return base

    try:
        patched = apply_candidate_patch(agent, patch)
    except ValueError as e:
        errors.append(str(e))
        return result()
    after = harness_ir_hash(patched)
    details.append(f"patch applied {before[:12]}… → {after[:12]}…")

    changes = security_cell_changes(agent, patched)
    if changes:
        errors.extend(f"candidate rejected: {c}" for c in changes)
        return result(harness_hash_after=after, security_changes=changes)
    details.append("security cells unchanged")

    if skip_fixtures:
        details.append("fixtures skipped — candidate NOT fitness-tested")
        return result(
            ok=True,
            harness_hash_after=after,
            fixtures_ok=True,
            security_ok=True,
            patched_agent=patched,
        )

    root = Path(fixtures_root) if fixtures_root else d.parents[1] / "conformance" / "fixtures"
    prefixes = fixture_prefixes_for_harness(d.name)
    if not prefixes and agent.get("mutable"):
        prefixes = ("cb-harness-patch-",)
    fixtures: list[dict[str, Any]] = []
    if not prefixes:
        details.append("no fixture prefixes — candidate NOT fitness-tested")
    elif not root.is_dir():
        errors.append(f"fixtures root missing: {root}")
    else:
        for child in sorted(root.iterdir()):
            if not (child.is_dir() and child.name.startswith(prefixes)):
                continue
            f = evaluate_fixture_fitness(child, agent, patched)
            fixtures.append(f)
            golden = "" if f["golden_ok"] else " (fixture golden stale)"
            if f["candidate_pass"] is None:
                details.append(
                    f"{f['fixture']}: not replayable on this harness "
                    f"({f['baseline'].get('error', '?')}){golden}"
                )
            elif f["candidate_pass"]:
                details.append(f"{f['fixture']}: candidate PASS{golden}")
            else:
                details.append(f"{f['fixture']}: candidate FAIL{golden}")
                errors.append(f"{f['fixture']}: candidate regressed — {'; '.join(f['reasons'])}")
    fitness = {
        "fixtures": len(fixtures),
        "replayable": sum(1 for f in fixtures if f["replayable"]),
        "candidate_passed": sum(1 for f in fixtures if f["candidate_pass"] is True),
        "candidate_failed": sum(1 for f in fixtures if f["candidate_pass"] is False),
    }
    if prefixes and fitness["replayable"] == 0 and not errors:
        details.append("no replayable fixture transcripts — candidate NOT fitness-tested")
    fixtures_ok = fitness["candidate_failed"] == 0 and not errors
    return result(
        ok=fixtures_ok,
        harness_hash_after=after,
        fixtures_ok=fixtures_ok,
        security_ok=True,
        fitness_evaluated=fitness["replayable"] > 0,
        fitness=fitness,
        fixtures=fixtures,
        patched_agent=patched,
    )
