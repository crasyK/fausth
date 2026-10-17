"""Command line.

    python -m fausth replay <fixture dir>... [--write]
        Replay fixtures and compare with their expected files (or write them).
    python -m fausth run <harness> --deployment <file> [--user TEXT]... [--log FILE] [--requests FILE]
        Run a harness with a deployment. Without --user, user messages are read from stdin, one per
        non-blank line.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .values import canonical


def _replay(args: argparse.Namespace) -> int:
    from .replay import replay

    failed = 0
    for directory in args.dirs:
        log, requests = replay(directory)
        for name, text in (("expected.log.jsonl", log), ("expected.requests.jsonl", requests)):
            path = Path(directory) / name
            if args.write:
                path.write_text(text, "utf-8", newline="\n")
            elif path.read_text("utf-8") != text:
                print(f"{path}: differs", file=sys.stderr)
                failed += 1
    return 0 if failed == 0 else 1


def _run(args: argparse.Namespace) -> int:
    from .engine import run
    from .harness import harness_errors, read_harness
    from .host import CliHost, DeploymentError, load_deployment

    try:
        harness = read_harness(Path(args.harness).read_text("utf-8"))
    except (OSError, ValueError) as e:
        print(f"invalid harness: {e}", file=sys.stderr)
        return 2
    errors = harness_errors(harness)
    if errors:
        print("invalid harness:\n  " + "\n  ".join(errors), file=sys.stderr)
        return 2
    try:
        deployment = load_deployment(args.deployment, harness)
        user = iter(args.user) if args.user else (line.rstrip("\n") for line in sys.stdin if line.strip())
        host = CliHost(deployment, Path(args.deployment).parent, user,
                       timeout_ms=harness.get("limits", {}).get("timeout_ms"), verbose=not args.quiet)
    except (DeploymentError, OSError, ValueError) as e:
        print(f"invalid deployment: {e}", file=sys.stderr)
        return 2
    log = run(harness, host)
    if args.log:
        Path(args.log).write_text(log.text(), "utf-8", newline="\n")
    if args.requests:
        Path(args.requests).write_text("".join(canonical(r) + "\n" for r in host.requests), "utf-8", newline="\n")
    reason = log.entries[-1]["reason"]
    if reason in ("infra_failure", "host_end") and host.failure:
        print(f"{reason}: {host.failure}", file=sys.stderr)
    print(f"run_end: {reason} after {sum(1 for e in log.entries if e['type'] == 'assistant')} model responses",
          file=sys.stderr)
    return 0 if reason == "stop" else 1


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="python -m fausth")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("replay", help="replay fixtures and compare with (or --write) their expected files")
    p.add_argument("dirs", nargs="+")
    p.add_argument("--write", action="store_true")
    p.set_defaults(fn=_replay)
    p = sub.add_parser("run", help="run a harness with a deployment")
    p.add_argument("harness")
    p.add_argument("--deployment", required=True)
    p.add_argument("--user", action="append", help="a user message (repeatable); default: stdin lines")
    p.add_argument("--log", help="write the log (JSON Lines) here")
    p.add_argument("--requests", help="write the rendered requests (JSON Lines) here")
    p.add_argument("--quiet", action="store_true")
    p.set_defaults(fn=_run)
    args = parser.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
