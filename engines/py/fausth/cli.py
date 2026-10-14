"""``fausth-py`` command line — Python twin of ``engines/ts/src/cli.ts``.

Commands mirror the TS CLI where the twin supports them (recorded transports
only; live model transports stay on the TS host).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from .canonical import canonical_json, js_trim, json_loads, read_jsonl, read_text_utf8
from .registry import AdapterError, load_agent_dir, load_yaml, resolve_tools_from_deployment
from .runtime import FaustRuntime, events_to_jsonl, parse_recorded_model_line, replay_fixture
from .packaging import inspect_harness, pack_harness, test_harness, select_harness
from .bundle import (
    BundleError,
    format_bundle_verify_report,
    resolve_harness_ref,
    unpack_bundle,
    verify_bundle_file,
)
from .bundle_signature import BundleSignatureError
from .connectors import (
    ConnectorError,
    resolve_harness,
    resolved_harness_canonical_json,
    resolved_harness_hash,
)


def _looks_like_repo(d: Path) -> bool:
    return (d / "conformance" / "fixtures").is_dir() and (d / "schema").is_dir()


def repo_root() -> Path:
    """Repository root for default paths (fixtures, examples).

    ``$FAUSTH_REPO_ROOT`` → nearest ancestor of the working directory that looks
    like a fausth checkout → nearest ancestor of this file. Independent of how
    deep the package sits (non-editable installs, vendored copies).
    """
    env = os.environ.get("FAUSTH_REPO_ROOT")
    if env:
        return Path(env).resolve()
    for start in (Path.cwd().resolve(), Path(__file__).resolve().parent):
        for d in (start, *start.parents):
            if _looks_like_repo(d):
                return d
    return Path.cwd().resolve()


def list_fixture_dirs(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    return sorted((p for p in root.iterdir() if p.is_dir()), key=lambda p: p.name)


def cmd_replay(dump_dir: str | None = None, fixtures_root: str | None = None) -> int:
    root = Path(fixtures_root).resolve() if fixtures_root else repo_root() / "conformance" / "fixtures"
    dirs = list_fixture_dirs(root)
    if not dirs:
        print("No fixtures found — failing (CI requires fixtures)", file=sys.stderr)
        return 1
    if dump_dir:
        Path(dump_dir).resolve().mkdir(parents=True, exist_ok=True)
    failed = 0
    for d in dirs:
        ok, actual, expected = replay_fixture(d)
        if dump_dir:
            (Path(dump_dir).resolve() / f"{d.name}.jsonl").write_text(actual, encoding="utf-8", newline="\n")
        if not ok:
            failed += 1
            print(f"FAIL {d.name}\n--- actual ---\n{actual}\n--- expected ---\n{expected}", file=sys.stderr)
        else:
            print(f"PASS {d.name}")
    return 0 if failed == 0 else 1


def cmd_validate(target: str) -> int:
    from .validate import validate_agent, validate_agent_path

    ref = resolve_harness_ref(target)
    try:
        if ref.embedded_resolved is not None:
            agent = ref.embedded_resolved["agent"]
            ok, errors, warnings = validate_agent(agent)
        else:
            hd = Path(ref.harness_dir)
            if (hd / "agent.yml").exists() or (hd / "agent.json").exists():
                # TS cmdValidate: validate the resolved harness (connector tools linked).
                try:
                    agent = resolve_harness(hd)["agent"]
                except ConnectorError as e:
                    print(str(e), file=sys.stderr)
                    return 1
                ok, errors, warnings = validate_agent(agent)
            else:
                ok, agent, errors, warnings = validate_agent_path(ref.harness_dir)
        if not ok:
            print("\n".join(errors), file=sys.stderr)
            return 1
        for w in warnings:
            print(f"WARN {w}", file=sys.stderr)
        print(f"OK {agent['name']}")
        print(canonical_json(agent))
        return 0
    finally:
        ref.cleanup()


def _default_deployment(agent_path: Path) -> Path:
    for name in ("deployment.fixture.yml", "deployment.simulation.yml", "deployment.ollama.yml"):
        cand = agent_path / name
        if cand.exists():
            return cand
    return agent_path / "deployment.openrouter-free.yml"


def cmd_run(
    agent_dir: str,
    deployment_path: str | None,
    model_path: str | None,
    dump_path: str | None,
    max_steps: int | None,
    *,
    embedded_resolved: dict | None = None,
    apply_overlays: bool = False,
    report_path: str | None = None,
    expect_complete: bool = False,
    workspace: str | None = None,
) -> int:
    agent_path = Path(agent_dir).resolve()
    try:
        resolved_harness = embedded_resolved if embedded_resolved is not None else resolve_harness(agent_path)
    except ConnectorError as e:
        print(str(e), file=sys.stderr)
        return 2
    dep_file = Path(deployment_path) if deployment_path else _default_deployment(agent_path)
    deployment = load_yaml(dep_file)

    agent = resolved_harness["agent"]
    if apply_overlays:
        from .overlays import resolve_overlay

        try:
            overlayed = resolve_overlay(agent, deployment)
        except ValueError as e:
            print(str(e), file=sys.stderr)
            return 2
        agent = overlayed["agent"]
        if overlayed["overlay"] is not None:
            print(f"overlay: {overlayed['reason']}", file=sys.stderr)

    if workspace:
        print("fausth-py run: --workspace (local real I/O) is TS-only", file=sys.stderr)
        return 2
    try:
        tools = resolve_tools_from_deployment(
            agent,
            deployment,
            harness_dir=str(agent_path),
            resolved={**resolved_harness, "agent": agent},
            deployment_path=str(dep_file.resolve()),
        )
    except AdapterError as e:
        print(str(e), file=sys.stderr)
        return 2

    with tools:
        transport = ((deployment or {}).get("model") or {}).get("transport") or "openai-compatible"
        if transport != "recorded":
            print(
                "fausth-py run currently supports recorded transport only "
                "(use TS fausth run for live models)",
                file=sys.stderr,
            )
            return 1
        mpath = model_path
        if not mpath:
            smoke = agent_path / "smoke.model.jsonl"
            if smoke.exists():
                mpath = str(smoke)
        if not mpath:
            print("recorded transport requires --model <jsonl> or smoke.model.jsonl in the agent dir", file=sys.stderr)
            return 1
        proposals = [parse_recorded_model_line(x) for x in read_jsonl(Path(mpath).resolve())]
        rt = FaustRuntime(agent, proposals, tools, None)
        rt.run_loop(max_steps if max_steps is not None else 32)
    out = events_to_jsonl(rt.events)
    if dump_path:
        p = Path(dump_path).resolve()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(out, encoding="utf-8", newline="\n")
    completed = any(
        e.get("tool") == "task.complete" and e.get("stage") == "execute" and e.get("verdict") == "allow"
        for e in rt.events
    )
    if report_path:
        test_exit = next(
            (e for e in reversed(rt.events) if e.get("tool") == "shell.run_allowlisted" and e.get("stage") == "execute"),
            None,
        )
        report = {
            "harness": agent_path.name,
            "deployment": dep_file.name,
            "workspace": None,
            "model": None,
            "connector_count": len(resolved_harness["resolution"]["connectors"]),
            "resolved_sha256": resolved_harness_hash(resolved_harness),
            "completion_reached": completed,
            "expect_complete": bool(expect_complete),
            "final_state": dict(rt.agent["state"]),
            "test_exit_code": (
                (test_exit.get("result") or {}).get("exit_code", -1)
                if test_exit and isinstance(test_exit.get("result"), dict)
                else None
            ),
            "diff_summary": [
                {
                    "path": e["args"]["path"] if isinstance((e.get("args") or {}).get("path"), str) else None,
                    "bytes": len(e["args"]["content"].encode("utf-8", "surrogatepass"))
                    if isinstance((e.get("args") or {}).get("content"), str)
                    else None,
                }
                for e in rt.events
                if e.get("tool") == "fs.write_scoped" and e.get("stage") == "execute" and e.get("verdict") == "allow"
            ][:8],
            "event_count": len(rt.events),
        }
        rp = Path(report_path).resolve()
        rp.parent.mkdir(parents=True, exist_ok=True)
        rp.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    # console.log(jsonl) in the TS CLI appends one more newline.
    sys.stdout.write(out + "\n")
    if expect_complete and not completed:
        print("expected task.complete allow but completion was not reached", file=sys.stderr)
        return 1
    return 0


# --------------------------------------------------------------------------
# audit (TS audit.ts)
# --------------------------------------------------------------------------


def _count_near_misses(events: list[dict[str, Any]]) -> int:
    n = 0
    for i in range(len(events) - 2):
        a, b, c = events[i], events[i + 1], events[i + 2]
        if (
            a.get("verdict") == "deny"
            and a.get("tool")
            and b.get("stage") == "propose"
            and b.get("tool") == a.get("tool")
            and c.get("verdict") == "deny"
            and c.get("tool") == a.get("tool")
        ):
            n += 1
    return n


def audit_events(events: list[dict[str, Any]], source: str = "<memory>") -> dict[str, Any]:
    by_reason: dict[str, int] = {}
    structured: dict[str, int] = {}
    denies = caps = out_fail = stale = budget = 0
    for e in events:
        if e.get("verdict") == "deny":
            denies += 1
            r = e.get("reason")
            r = "unknown" if r is None else r
            by_reason[r] = by_reason.get(r, 0) + 1
            if r == "capability_missing":
                caps += 1
            if r == "verify_output_failed":
                out_fail += 1
            kind = (e.get("failure") or {}).get("kind") if isinstance(e.get("failure"), dict) else None
            if kind:
                structured[kind] = structured.get(kind, 0) + 1
        if e.get("reason") == "memory_stale":
            stale += 1
        if e.get("reason") == "budget_exceeded":
            budget += 1
    return {
        "source": source,
        "events": len(events),
        "denies": denies,
        "by_reason": by_reason,
        "capability_missing": caps,
        "structured_failures": structured,
        "near_misses": _count_near_misses(events),
        "verify_output_failed": out_fail,
        "memory_stale": stale,
        "budget_exceeded": budget,
    }


def format_audit_human(s: dict[str, Any]) -> str:
    def rows(d: dict[str, int]) -> str:
        return "\n".join(f"  {k}: {v}" for k, v in sorted(d.items(), key=lambda kv: -kv[1]))

    reasons = rows(s["by_reason"])
    failures = rows(s["structured_failures"])
    return "\n".join(
        [
            f"fausth audit — {s['source']}",
            f"events: {s['events']}  denies: {s['denies']}  near_misses: {s['near_misses']}",
            f"capability_missing: {s['capability_missing']}  verify_output_failed: {s['verify_output_failed']}",
            f"memory_stale: {s['memory_stale']}  budget_exceeded: {s['budget_exceeded']}",
            f"by_reason:\n{reasons}" if reasons else "by_reason: (none)",
            f"structured_failures:\n{failures}" if failures else "structured_failures: (none)",
        ]
    )


def cmd_audit(file: str, as_json: bool) -> int:
    path = Path(file).resolve()
    if not path.exists():
        alt = (repo_root() / file).resolve()
        path = alt
    try:
        if not path.exists():
            raise FileNotFoundError(f"audit: file not found: {path}")
        text = read_text_utf8(path).replace("\r\n", "\n")
        events = [json_loads(line) for line in text.split("\n") if js_trim(line)]
        summary = audit_events(events, str(path))
    except (OSError, ValueError) as e:
        print(str(e), file=sys.stderr)
        return 1
    print(canonical_json(summary) if as_json else format_audit_human(summary))
    return 0


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------


def _add_trust_flags(p: argparse.ArgumentParser) -> None:
    """Bundle trust / spawn policy flags (map to the env settings both engines read)."""
    p.add_argument("--trusted-keys", default=None, dest="trusted_keys", help="trusted-keys file (FAUSTH_TRUSTED_KEYS)")
    p.add_argument(
        "--require-trusted",
        action="store_true",
        dest="require_trusted",
        help="accept only signed-trusted bundles (FAUSTH_REQUIRE_TRUSTED_BUNDLES=1)",
    )
    p.add_argument(
        "--allow-command",
        action="append",
        default=None,
        dest="allow_commands",
        help="operator-allowed command for bundle-declared stdio servers; repeatable, '*' = any (FAUSTH_ALLOW_COMMANDS)",
    )


def _apply_trust_flags(args: argparse.Namespace) -> None:
    if getattr(args, "trusted_keys", None):
        os.environ["FAUSTH_TRUSTED_KEYS"] = str(Path(args.trusted_keys).resolve())
    if getattr(args, "require_trusted", False):
        os.environ["FAUSTH_REQUIRE_TRUSTED_BUNDLES"] = "1"
    allow = getattr(args, "allow_commands", None)
    if allow:
        existing = [s.strip() for s in os.environ.get("FAUSTH_ALLOW_COMMANDS", "").split(",") if s.strip()]
        merged = "*" if "*" in allow or "*" in existing else ",".join(dict.fromkeys([*existing, *allow]))
        os.environ["FAUSTH_ALLOW_COMMANDS"] = merged


def main(argv: list[str] | None = None) -> None:
    if argv is None:
        argv = sys.argv[1:]
    if argv and argv[0] in ("--version", "-V", "version"):
        from . import __version__

        print(f"fausth-py {__version__}")
        raise SystemExit(0)
    parser = argparse.ArgumentParser(prog="fausth-py")
    sub = parser.add_subparsers(dest="cmd")
    p_validate = sub.add_parser("validate")
    p_validate.add_argument("agent", nargs="?", default=None)
    p_replay = sub.add_parser("replay")
    p_replay.add_argument("fixtures", nargs="?", default=None)
    p_replay.add_argument("--dump-dir", default=None)
    p_run = sub.add_parser("run")
    p_run.add_argument("agent", nargs="?", default=None)
    p_run.add_argument("--deployment", default=None)
    p_run.add_argument("--model", default=None)
    p_run.add_argument("--dump", default=None)
    p_run.add_argument("--max-steps", type=int, default=None)
    p_run.add_argument("--apply-overlays", action="store_true")
    p_run.add_argument("--report", default=None)
    p_run.add_argument("--expect-complete", action="store_true")
    p_run.add_argument("--workspace", default=None)
    p_inspect = sub.add_parser("inspect")
    p_inspect.add_argument("agent", nargs="?", default=None)
    p_resolve = sub.add_parser("resolve")
    p_resolve.add_argument("agent", nargs="?", default=None)
    p_resolve.add_argument("--out", default=None)
    p_test = sub.add_parser("test")
    p_test.add_argument("agent", nargs="?", default=None)
    p_test.add_argument("--deployment", default=None)
    p_test.add_argument("--skip-fixtures", action="store_true")
    p_pack = sub.add_parser("pack")
    p_pack.add_argument("agent", nargs="?", default=None)
    p_pack.add_argument("--out", default=None)
    p_pack.add_argument("--sign-key", default=None, dest="sign_key")
    p_unpack = sub.add_parser("unpack")
    p_unpack.add_argument("bundle")
    p_unpack.add_argument("--out", required=True)
    p_unpack.add_argument("--force", action="store_true")
    p_verify = sub.add_parser("verify")
    p_verify.add_argument("bundle")
    p_audit = sub.add_parser("audit")
    p_audit.add_argument("events")
    p_audit.add_argument("--json", action="store_true", dest="as_json")
    p_select = sub.add_parser("select")
    p_select.add_argument("agent", nargs="?", default=None)
    p_select.add_argument("--candidate-patch", required=True, dest="candidate_patch")
    p_select.add_argument("--skip-fixtures", action="store_true")
    p_select.add_argument("--out-agent", default=None, dest="out_agent")
    for p in (p_validate, p_run, p_inspect, p_resolve, p_test, p_unpack, p_verify):
        _add_trust_flags(p)
    args = parser.parse_args(argv)
    _apply_trust_flags(args)
    default_agent = str(repo_root() / "examples" / "coding-counterbalance")
    if args.cmd == "audit":
        raise SystemExit(cmd_audit(args.events, args.as_json))
    if args.cmd == "validate":
        target = args.agent or str(repo_root() / "examples" / "greenhouse")
        try:
            raise SystemExit(cmd_validate(target))
        except (BundleError, ValueError, OSError) as e:
            print(str(e), file=sys.stderr)
            raise SystemExit(1)
    if args.cmd == "replay":
        raise SystemExit(cmd_replay(args.dump_dir, args.fixtures))
    if args.cmd == "run":
        resolved = resolve_harness_ref(args.agent or str(repo_root() / "examples" / "greenhouse"))
        try:
            raise SystemExit(
                cmd_run(
                    str(resolved.harness_dir),
                    args.deployment,
                    args.model,
                    args.dump,
                    args.max_steps,
                    embedded_resolved=resolved.embedded_resolved,
                    apply_overlays=args.apply_overlays,
                    report_path=args.report,
                    expect_complete=args.expect_complete,
                    workspace=args.workspace,
                )
            )
        finally:
            resolved.cleanup()
    if args.cmd == "inspect":
        resolved = resolve_harness_ref(args.agent or default_agent)
        try:
            report = inspect_harness(
                str(resolved.harness_dir),
                embedded_resolved=resolved.embedded_resolved,
                bundle_format=resolved.bundle_format,
            )
            print(json.dumps(report, indent=2, ensure_ascii=False))
            cov = report.get("binding_coverage") or {}
            raise SystemExit(0 if cov.get("ok", True) else 1)
        finally:
            resolved.cleanup()
    if args.cmd == "resolve":
        resolved_ref = resolve_harness_ref(args.agent or default_agent)
        try:
            resolved = (
                resolved_ref.embedded_resolved
                if resolved_ref.embedded_resolved is not None
                else resolve_harness(resolved_ref.harness_dir)
            )
            text = resolved_harness_canonical_json(resolved)
            if args.out:
                out_path = Path(args.out).resolve()
                out_path.parent.mkdir(parents=True, exist_ok=True)
                out_path.write_text(text, encoding="utf-8", newline="\n")
                print(
                    f"resolved {len(resolved['resolution']['connectors'])} connectors → "
                    f"{out_path} (sha256={resolved_harness_hash(resolved)})"
                )
            else:
                sys.stdout.write(text)
            raise SystemExit(0)
        except ConnectorError as e:
            print(str(e), file=sys.stderr)
            raise SystemExit(1)
        finally:
            resolved_ref.cleanup()
    if args.cmd == "test":
        resolved = resolve_harness_ref(args.agent or default_agent)
        try:
            result = test_harness(
                str(resolved.harness_dir),
                deployment=args.deployment,
                skip_fixtures=args.skip_fixtures,
                embedded_resolved=resolved.embedded_resolved,
                bundle_format=resolved.bundle_format,
            )
            for d in result.get("details") or []:
                print(d)
            if not result.get("ok"):
                for e in result.get("errors") or []:
                    print(e, file=sys.stderr)
                raise SystemExit(1)
            print("test OK")
            raise SystemExit(0)
        finally:
            resolved.cleanup()
    if args.cmd == "pack":
        try:
            r = pack_harness(args.agent or default_agent, args.out, sign_key=args.sign_key)
            signed = ", signed ed25519" if r.get("signed") else ""
            print(f"packed {len(r['files'])} files → {r['out']} ({r['format']}{signed})")
            raise SystemExit(0)
        except (BundleSignatureError, ConnectorError, OSError) as e:
            print(str(e), file=sys.stderr)
            raise SystemExit(1)
    if args.cmd == "unpack":
        try:
            dest = unpack_bundle(args.bundle, args.out, force=args.force)
            print(f"unpacked → {dest}")
            raise SystemExit(0)
        except BundleError as e:
            print(str(e), file=sys.stderr)
            raise SystemExit(1)
    if args.cmd == "verify":
        report = verify_bundle_file(args.bundle)
        line = format_bundle_verify_report(report)
        print(line, file=sys.stdout if report["exit_code"] == 0 else sys.stderr)
        raise SystemExit(report["exit_code"])
    if args.cmd == "select":
        target = args.agent or default_agent
        patch = json_loads(read_text_utf8(Path(args.candidate_patch)))
        result = select_harness(
            target,
            patch,
            fixtures_root=str(repo_root() / "conformance" / "fixtures"),
            skip_fixtures=args.skip_fixtures,
        )
        for d in result["details"]:
            print(d)
        if args.out_agent and result.get("patched_agent"):
            outp = Path(args.out_agent).resolve()
            outp.parent.mkdir(parents=True, exist_ok=True)
            outp.write_text(canonical_json(result["patched_agent"]) + "\n", encoding="utf-8", newline="\n")
            print(f"wrote patched agent → {outp}")
        if not result["ok"]:
            for e in result["errors"]:
                print(e, file=sys.stderr)
            raise SystemExit(1)
        print(f"select OK ({result['harness_hash_before'][:12]}… → {result['harness_hash_after'][:12]}…)")
        raise SystemExit(0)
    parser.print_help()
    raise SystemExit(0)


if __name__ == "__main__":
    main()
