"""Harness bundle load / unpack (fausth-harness-bundle/v0.1)."""
from __future__ import annotations

import json
import re
import tempfile
from pathlib import Path
from typing import Any, Callable

BUNDLE_FORMAT = "fausth-harness-bundle/v0.1"
BUNDLE_MAX_FILES = 64
BUNDLE_MAX_FILE_BYTES = 1_048_576
BUNDLE_MAX_TOTAL_BYTES = 8_388_608

ALLOWED_FILE_RE = re.compile(
    r"^(agent\.(yml|yaml|json)|README\.md|smoke\.(model|expected)\.jsonl|deployment\.[A-Za-z0-9._-]+\.ya?ml)$"
)
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class BundleError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def is_bundle_path(path: str | Path) -> bool:
    return str(path).endswith(".fausth.json")


def assert_safe_bundle_entry_name(name: str) -> None:
    if not name or not isinstance(name, str):
        raise BundleError("bundle_path", "empty bundle entry name")
    if "\0" in name:
        raise BundleError("bundle_path", "bundle entry contains NUL")
    if "/" in name or "\\" in name or ".." in name:
        raise BundleError("bundle_path", f"unsafe bundle path: {name}")
    if re.match(r"^[a-zA-Z]:", name) or name.startswith("~"):
        raise BundleError("bundle_path", f"absolute/drive bundle path: {name}")
    if not ALLOWED_FILE_RE.match(name):
        raise BundleError("bundle_unknown_entry", f"unknown or disallowed bundle entry: {name}")


def validate_bundle(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise BundleError("bundle_invalid", "bundle must be an object")
    if raw.get("format") != BUNDLE_FORMAT:
        raise BundleError(
            "bundle_invalid",
            f"expected format {BUNDLE_FORMAT}, got {raw.get('format')!r}",
        )
    name = raw.get("name")
    if not isinstance(name, str) or not name:
        raise BundleError("bundle_invalid", "bundle.name must be a non-empty string")
    if not NAME_RE.match(name):
        raise BundleError("bundle_invalid", "bundle.name has invalid characters")
    files = raw.get("files")
    if not isinstance(files, dict):
        raise BundleError("bundle_invalid", "bundle.files must be an object")
    if not files:
        raise BundleError("bundle_invalid", "bundle.files is empty")
    if len(files) > BUNDLE_MAX_FILES:
        raise BundleError("bundle_too_large", f"too many files (max {BUNDLE_MAX_FILES})")
    out: dict[str, str] = {}
    total = 0
    for key in sorted(files.keys()):
        assert_safe_bundle_entry_name(key)
        content = files[key]
        if not isinstance(content, str):
            raise BundleError("bundle_invalid", f"file content must be UTF-8 string: {key}")
        if "\0" in content:
            raise BundleError("bundle_invalid", f"NUL in file content: {key}")
        nbytes = len(content.encode("utf-8"))
        if nbytes > BUNDLE_MAX_FILE_BYTES:
            raise BundleError("bundle_too_large", f"file too large: {key}")
        total += nbytes
        out[key] = content
    if total > BUNDLE_MAX_TOTAL_BYTES:
        raise BundleError("bundle_too_large", "bundle total size exceeds limit")
    if not any(k in ("agent.yml", "agent.yaml", "agent.json") for k in out):
        raise BundleError("bundle_invalid", "bundle requires agent.yml, agent.yaml, or agent.json")
    return {"format": BUNDLE_FORMAT, "name": name, "files": out}


def load_bundle_file(path: str | Path) -> dict[str, Any]:
    p = Path(path).resolve()
    if not p.is_file():
        raise BundleError("not_found", f"bundle not found: {p}")
    try:
        parsed = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise BundleError("bundle_invalid", f"invalid JSON: {e}") from e
    return validate_bundle(parsed)


def unpack_bundle(
    bundle: dict[str, Any] | str | Path,
    out_dir: str | Path,
    *,
    force: bool = False,
) -> Path:
    if isinstance(bundle, dict):
        b = validate_bundle(bundle)
    else:
        b = load_bundle_file(bundle)
    dest = Path(out_dir).resolve()
    if dest.exists():
        if any(dest.iterdir()) and not force:
            raise BundleError("bundle_invalid", f"output directory not empty: {dest} (pass --force)")
    else:
        dest.mkdir(parents=True, exist_ok=True)
    for name in b["files"]:
        assert_safe_bundle_entry_name(name)
    for name, content in b["files"].items():
        (dest / name).write_text(content, encoding="utf-8", newline="\n")
    return dest


class ResolvedHarness:
    def __init__(self, kind: str, harness_dir: Path, source: Path, cleanup: Callable[[], None]) -> None:
        self.kind = kind
        self.harness_dir = harness_dir
        self.source = source
        self._cleanup = cleanup

    def cleanup(self) -> None:
        self._cleanup()


def resolve_harness_ref(ref: str | Path) -> ResolvedHarness:
    abs_path = Path(ref).resolve()
    if not abs_path.exists():
        raise BundleError("not_found", f"harness not found: {abs_path}")
    if abs_path.is_dir():
        return ResolvedHarness("dir", abs_path, abs_path, lambda: None)
    if abs_path.is_file() and is_bundle_path(abs_path):
        tmp = Path(tempfile.mkdtemp(prefix="fausth-bundle-"))
        unpack_bundle(abs_path, tmp, force=True)

        def _cleanup() -> None:
            import shutil

            shutil.rmtree(tmp, ignore_errors=True)

        return ResolvedHarness("bundle", tmp, abs_path, _cleanup)
    raise BundleError(
        "bundle_invalid",
        f"expected harness directory or .fausth.json bundle, got: {abs_path.name}",
    )
