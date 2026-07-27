from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .registry import AdapterError, load_agent_dir, load_yaml, resolve_tools_from_deployment
from .runtime import FaustRuntime, events_to_jsonl, replay_fixture


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
) -> int:
    agent_path = Path(agent_dir).resolve()
    agent = load_agent_dir(str(agent_path))
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
        tools = resolve_tools_from_deployment(agent, deployment)
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
    args = parser.parse_args(argv)
    if args.cmd == "replay":
        raise SystemExit(cmd_replay(args.dump_dir))
    if args.cmd == "run":
        agent = args.agent or str(repo_root() / "examples" / "coding-counterbalance")
        raise SystemExit(
            cmd_run(agent, args.deployment, args.model, args.dump, args.max_steps)
        )
    parser.print_help()
    raise SystemExit(0)


if __name__ == "__main__":
    main()
