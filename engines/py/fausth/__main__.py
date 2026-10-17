"""Command line: `python -m fausth replay <fixture dir>... [--write]` compares a replay with the
expected files, or (with --write) writes them."""
from __future__ import annotations

import sys
from pathlib import Path

from .replay import replay


def main(args: list[str]) -> int:
    if not args or args[0] != "replay":
        print("usage: python -m fausth replay <fixture dir>... [--write]", file=sys.stderr)
        return 2
    write = "--write" in args
    failed = 0
    for directory in (a for a in args[1:] if a != "--write"):
        log, requests = replay(directory)
        for name, text in (("expected.log.jsonl", log), ("expected.requests.jsonl", requests)):
            path = Path(directory) / name
            if write:
                path.write_text(text, "utf-8", newline="\n")
            elif path.read_text("utf-8") != text:
                print(f"{path}: differs", file=sys.stderr)
                failed += 1
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
