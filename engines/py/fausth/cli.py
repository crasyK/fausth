from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .registry import AdapterError, load_agent_dir, load_yaml, resolve_tools_from_deployment
from .runtime import FaustRuntime, events_to_jsonl, replay_fixture
from .packaging import inspect_harness, pack_harness, test_harness
from .bundle import BundleError, load_bundle_file, resolve_harness_ref, unpack_bundle
from .bundle_signature import BundleSignatureError
from .connectors import (
    ConnectorError,
    resolve_harness,
    resolved_harness_canonical_json,
    resolved_harness_hash,
)


def repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def cmd_replay(dump_dir: str | None = None) -> int:
    root = repo_root() / "conformance" / "fixtures"
    dirs = sorted([p for p in root.iterdir() if p.is_dir()])
    if not dirs:
        print("No fixtures found — failing", file=sys.stderr)
        return 1
    failed = 0
    for d in dirs:
        ok, actual, expected = replay_fixture(d)
        if dump_dir:
            Path(dump_dir).mkdir(parents=True, exist_ok=True)
            (Path(dump_dir) / f"{d.name}.jsonl").write_text(actual, encoding="utf-8")
        if not ok:
            failed += 1
            print(f"FAIL {d.name}", file=sys.stderr)
            print("--- actual ---", file=sys.stderr)
            print(actual, file=sys.stderr)
            print("--- expected ---", file=sys.stderr)
            print(expected, file=sys.stderr)
        else:
            print(f"PASS {d.name}")
    return 0 if failed == 0 else 1


def cmd_run(
    agent_dir: str,
    deployment_path: str | None,
    model_path: str | None,
    dump_path: str | None,
    max_steps: int | None,
    *,
    embedded_resolved: dict | None = None,
) -> int:
    agent_path = Path(agent_dir).resolve()
    try:
        resolved_harness = embedded_resolved if embedded_resolved is not None else resolve_harness(agent_path)
    except ConnectorError as e:
        print(str(e), file=sys.stderr)
        return 2
    agent = resolved_harness["agent"]
    dep_file = deployment_path
    if not dep_file:
        for name in (
            "deployment.fixture.yml",
            "deployment.simulation.yml",
            "deployment.openrouter-free.yml",
        ):
            cand = agent_path / name
            if cand.exists():
                dep_file = str(cand)
                break
    if not dep_file:
        print("No deployment.yml found; pass --deployment", file=sys.stderr)
        return 1
    deployment = load_yaml(dep_file)
    try:
        tools = resolve_tools_from_deployment(
            agent,
            deployment,
            harness_dir=str(agent_path),
            resolved=resolved_harness,
        )
    except AdapterError as e:
        print(str(e), file=sys.stderr)
        return 2

    transport = (deployment.get("model") or {}).get("transport", "recorded")
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
        print("recorded transport requires --model <jsonl> or smoke.model.jsonl", file=sys.stderr)
        return 1

    proposals = [
        json.loads(line)
        for line in Path(mpath).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    rt = FaustRuntime(agent, proposals, tools, None)
    rt.run_loop(max_steps if max_steps is not None else 32)
    out = events_to_jsonl(rt.events)
    if dump_path:
        p = Path(dump_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(out, encoding="utf-8", newline="\n")
    sys.stdout.write(out)
    return 0


def main(argv: list[str] | None = None) -> None:
    if argv is None:
        argv = sys.argv[1:]
    if argv and argv[0] in ("--version", "-V", "version"):
        from . import __version__

        print(f"fausth-py {__version__}")
        raise SystemExit(0)
    parser = argparse.ArgumentParser(prog="fausth-py")
    sub = parser.add_subparsers(dest="cmd")
    p_replay = sub.add_parser("replay")
    p_replay.add_argument("--dump-dir", default=None)
    p_run = sub.add_parser("run")
    p_run.add_argument("agent", nargs="?", default=None)
    p_run.add_argument("--deployment", default=None)
    p_run.add_argument("--model", default=None)
    p_run.add_argument("--dump", default=None)
    p_run.add_argument("--max-steps", type=int, default=None)
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
    args = parser.parse_args(argv)
    default_agent = str(repo_root() / "examples" / "coding-counterbalance")
    if args.cmd == "replay":
        raise SystemExit(cmd_replay(args.dump_dir))
    if args.cmd == "run":
        agent = args.agent or default_agent
        resolved = resolve_harness_ref(agent)
        try:
            raise SystemExit(
                cmd_run(
                    str(resolved.harness_dir),
                    args.deployment,
                    args.model,
                    args.dump,
                    args.max_steps,
                    embedded_resolved=resolved.embedded_resolved,
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
            print(json.dumps(report, indent=2, sort_keys=True))
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
                    f"resolved {len(resolved['resolution']['connectors'])} connectors -> "
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
            r = pack_harness(
                args.agent or default_agent,
                args.out,
                sign_key=args.sign_key,
            )
            signed = ", signed ed25519" if r.get("signed") else ""
            print(f"packed {len(r['files'])} files -> {r['out']} ({r['format']}{signed})")
            raise SystemExit(0)
        except BundleSignatureError as e:
            print(str(e), file=sys.stderr)
            raise SystemExit(1)
    if args.cmd == "unpack":
        try:
            dest = unpack_bundle(args.bundle, args.out, force=args.force)
            print(f"unpacked -> {dest}")
            raise SystemExit(0)
        except BundleError as e:
            print(str(e), file=sys.stderr)
            raise SystemExit(1)
    if args.cmd == "verify":
        try:
            bundle = load_bundle_file(args.bundle)
            sig = bundle.get("signature")
            if sig:
                print(
                    f"OK signature ed25519 public_key={sig['public_key']} ({bundle['format']})"
                )
            else:
                print(f"OK unsigned bundle ({bundle['format']})")
            raise SystemExit(0)
        except BundleError as e:
            print(str(e), file=sys.stderr)
            raise SystemExit(1)
    parser.print_help()
    raise SystemExit(0)


if __name__ == "__main__":
    main()
