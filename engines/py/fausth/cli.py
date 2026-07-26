from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .runtime import replay_fixture


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


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="fausth-py")
    sub = parser.add_subparsers(dest="cmd")
    p_replay = sub.add_parser("replay")
    p_replay.add_argument("--dump-dir", default=None)
    args = parser.parse_args(argv)
    if args.cmd == "replay":
        raise SystemExit(cmd_replay(args.dump_dir))
    parser.print_help()
    raise SystemExit(0)


if __name__ == "__main__":
    main()
