"""Harness bundle load / unpack (fausth-harness-bundle/v0.1 + v0.2)."""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any, Callable

from .canonical import canonical_json
from .bundle_signature import BundleSignatureError, verify_bundle_signature
from .connectors import RESOLVED_HARNESS_FORMAT, resolved_harness_hash

BUNDLE_FORMAT_V01 = "fausth-harness-bundle/v0.1"
BUNDLE_FORMAT_V02 = "fausth-harness-bundle/v0.2"
BUNDLE_FORMAT = BUNDLE_FORMAT_V01
BUNDLE_MAX_FILES = 96
BUNDLE_MAX_FILE_BYTES = 1_048_576
BUNDLE_MAX_TOTAL_BYTES = 8_388_608

ALLOWED_FILE_RE_V01 = re.compile(
    r"^(agent\.(yml|yaml|json)|README\.md|smoke\.(model|expected)\.jsonl|deployment\.[A-Za-z0-9._-]+\.ya?ml)$"
)
ALLOWED_FILE_RE_V02 = re.compile(
    r"^(agent\.(yml|yaml|json)|README\.md|smoke\.(model|expected)\.jsonl|deployment\.[A-Za-z0-9._-]+\.ya?ml|"
    r"connectors\.(yml|yaml|json)|connectors/[A-Za-z0-9._-]+\.(yml|yaml|json))$"
)
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class BundleError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def is_bundle_path(path: str | Path) -> bool:
    return str(path).endswith(".fausth.json")


def is_harness_bundle_v2(bundle: dict[str, Any]) -> bool:
    return bundle.get("format") == BUNDLE_FORMAT_V02


def assert_safe_bundle_entry_name(name: str, format: str = BUNDLE_FORMAT_V01) -> None:
    if not name or not isinstance(name, str):
        raise BundleError("bundle_path", "empty bundle entry name")
    if "\0" in name:
        raise BundleError("bundle_path", "bundle entry contains NUL")
    if "\\" in name:
        raise BundleError("bundle_path", f"backslash paths forbidden: {name}")
    if re.match(r"^[a-zA-Z]:", name) or name.startswith("~") or name.startswith("/"):
        raise BundleError("bundle_path", f"absolute/drive bundle path: {name}")
    parts = name.split("/")
    if any(p in ("", ".", "..", ".git") for p in parts):
        raise BundleError("bundle_path", f"unsafe bundle path: {name}")
    if format == BUNDLE_FORMAT_V01:
        if "/" in name:
            raise BundleError("bundle_path", f"unsafe bundle path: {name}")
        if not ALLOWED_FILE_RE_V01.match(name):
            raise BundleError("bundle_unknown_entry", f"unknown or disallowed bundle entry: {name}")
        return
    if not ALLOWED_FILE_RE_V02.match(name):
        raise BundleError("bundle_unknown_entry", f"unknown or disallowed bundle entry: {name}")


def _validate_files_map(files: Any, format: str) -> dict[str, str]:
    if not isinstance(files, dict):
        raise BundleError("bundle_invalid", "bundle.files must be an object")
    if not files:
        raise BundleError("bundle_invalid", "bundle.files is empty")
    if len(files) > BUNDLE_MAX_FILES:
        raise BundleError("bundle_too_large", f"too many files (max {BUNDLE_MAX_FILES})")
    out: dict[str, str] = {}
    total = 0
    for key in sorted(files.keys()):
        assert_safe_bundle_entry_name(key, format)
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
    return out


def _validate_resolved_object(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise BundleError("bundle_invalid", "bundle.resolved must be an object")
    if raw.get("format") != RESOLVED_HARNESS_FORMAT:
        raise BundleError(
            "bundle_invalid",
            f"bundle.resolved.format must be {RESOLVED_HARNESS_FORMAT}",
        )
    if not isinstance(raw.get("agent"), dict):
        raise BundleError("bundle_invalid", "bundle.resolved.agent must be an object")
    if not isinstance(raw.get("resolution"), dict):
        raise BundleError("bundle_invalid", "bundle.resolved.resolution must be an object")
    return raw


def verify_bundle_integrity(bundle: dict[str, Any]) -> None:
    resolved = bundle["resolved"]
    expected = resolved_harness_hash(resolved)
    got = bundle.get("resolved_sha256")
    if got != expected:
        raise BundleError(
            "bundle_resolved_hash_mismatch",
            f"resolved_sha256 mismatch: expected {expected}, got {got}",
        )
    for lock in resolved.get("resolution", {}).get("lock", []):
        kind = lock.get("kind")
        if kind == "inline":
            continue
        if kind != "file":
            raise BundleError(
                "bundle_invalid",
                f"unsupported connector kind in resolved lock: {kind!r}",
            )
        path = lock.get("path")
        if not path:
            raise BundleError("bundle_lock_file_missing", "file lock entry missing path")
        assert_safe_bundle_entry_name(path, BUNDLE_FORMAT_V02)
        content = bundle["files"].get(path)
        if content is None:
            raise BundleError(
                "bundle_lock_file_missing",
                f"lock path missing from bundle files: {path}",
            )
        digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
        if digest != lock.get("sha256"):
            raise BundleError(
                "bundle_lock_hash_mismatch",
                f"sha256 mismatch for {path}: expected {lock.get('sha256')}, got {digest}",
            )


def _attach_optional_signature(bundle: dict[str, Any], raw: dict[str, Any]) -> dict[str, Any]:
    if "signature" not in raw or raw["signature"] is None:
        return bundle
    try:
        verify_bundle_signature(raw)
    except BundleSignatureError as e:
        code = (
            "bundle_signature_unsupported"
            if e.code == "bundle_signature_unsupported"
            else "bundle_signature_invalid"
        )
        raise BundleError(code, str(e)) from e
    out = dict(bundle)
    out["signature"] = raw["signature"]
    return out


def validate_bundle(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise BundleError("bundle_invalid", "bundle must be an object")
    format_ = raw.get("format")
    if format_ not in (BUNDLE_FORMAT_V01, BUNDLE_FORMAT_V02):
        raise BundleError(
            "bundle_invalid",
            f"expected format {BUNDLE_FORMAT_V01} or {BUNDLE_FORMAT_V02}, got {format_!r}",
        )
    name = raw.get("name")
    if not isinstance(name, str) or not name:
        raise BundleError("bundle_invalid", "bundle.name must be a non-empty string")
    if not NAME_RE.match(name):
        raise BundleError("bundle_invalid", "bundle.name has invalid characters")
    files = _validate_files_map(raw.get("files"), format_)

    if format_ == BUNDLE_FORMAT_V01:
        if "resolved" in raw or "resolved_sha256" in raw:
            raise BundleError("bundle_invalid", "v0.1 bundle must not include resolved fields")
        bundle = {"format": BUNDLE_FORMAT_V01, "name": name, "files": files}
        return _attach_optional_signature(bundle, raw)

    resolved_sha256 = raw.get("resolved_sha256")
    if not isinstance(resolved_sha256, str) or not re.fullmatch(r"[a-f0-9]{64}", resolved_sha256):
        raise BundleError(
            "bundle_invalid",
            "bundle.resolved_sha256 must be a 64-char lowercase hex string",
        )
    resolved = _validate_resolved_object(raw.get("resolved"))
    bundle = {
        "format": BUNDLE_FORMAT_V02,
        "name": name,
        "files": files,
        "resolved": resolved,
        "resolved_sha256": resolved_sha256,
    }
    with_sig = _attach_optional_signature(bundle, raw)
    verify_bundle_integrity(with_sig)
    return with_sig


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
        assert_safe_bundle_entry_name(name, b["format"])
    for name, content in b["files"].items():
        target = dest / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8", newline="\n")
    return dest


class ResolvedHarness:
    def __init__(
        self,
        kind: str,
        harness_dir: Path,
        source: Path,
        cleanup: Callable[[], None],
        *,
        bundle_format: str | None = None,
        embedded_resolved: dict[str, Any] | None = None,
    ) -> None:
        self.kind = kind
        self.harness_dir = harness_dir
        self.source = source
        self.bundle_format = bundle_format
        self.embedded_resolved = embedded_resolved
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
        loaded = load_bundle_file(abs_path)
        tmp = Path(tempfile.mkdtemp(prefix="fausth-bundle-"))
        unpack_bundle(loaded, tmp, force=True)

        def _cleanup() -> None:
            shutil.rmtree(tmp, ignore_errors=True)

        return ResolvedHarness(
            "bundle",
            tmp,
            abs_path,
            _cleanup,
            bundle_format=loaded["format"],
            embedded_resolved=loaded["resolved"] if is_harness_bundle_v2(loaded) else None,
        )
    raise BundleError(
        "bundle_invalid",
        f"expected harness directory or .fausth.json bundle, got: {abs_path.name}",
    )


def bundle_canonical_json(bundle: dict[str, Any]) -> str:
    return canonical_json(bundle) + "\n"
