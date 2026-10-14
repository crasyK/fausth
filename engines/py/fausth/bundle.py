"""Harness bundle load / unpack / verify (fausth-harness-bundle/v0.1 + v0.2 + v0.3).

Mirrors engines/ts/src/bundle.ts:

- A signature proves only "signed by the key embedded in the bundle"; trust comes from an
  operator trust store (FAUSTH_TRUSTED_KEYS / ``trusted_keys``): unsigned |
  signed-untrusted | signed-trusted.
- ``require_trusted`` (FAUSTH_REQUIRE_TRUSTED_BUNDLES=1) rejects all but signed-trusted.
- The embedded resolved IR executes for v0.2/v0.3 bundles, so it must equal the
  re-resolution of the shipped source files (``bundle_resolved_mismatch``).
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any, Callable

from .canonical import INT53_MAX, INT53_MIN, canonical_json
from .bundle_signature import (
    BundleSignatureError,
    classify_bundle_trust,
    load_trust_store,
    require_trusted_from_env,
    trust_store_from_env,
)
from .connectors import RESOLVED_HARNESS_FORMAT, resolve_harness, resolved_harness_hash
from .provenance import register_bundle_dir, unregister_bundle_dir

BUNDLE_FORMAT_V01 = "fausth-harness-bundle/v0.1"
BUNDLE_FORMAT_V02 = "fausth-harness-bundle/v0.2"
BUNDLE_FORMAT_V03 = "fausth-harness-bundle/v0.3"
BUNDLE_FORMAT = BUNDLE_FORMAT_V01
BUNDLE_MAX_FILES = 96
BUNDLE_MAX_FILE_BYTES = 1_048_576
BUNDLE_MAX_TOTAL_BYTES = 8_388_608
#: Matches ``propertyNames.maxLength`` in the bundle schemas.
BUNDLE_MAX_ENTRY_NAME = 200

# All patterns are applied with fullmatch (``$`` would accept a trailing newline).
#: ``user.answers.jsonl`` carries recorded user-channel answers (D14, spec-v0.3 §15.2).
#: Each pattern must stay identical to schema/fausth-harness-bundle.v0.x.json ``propertyNames.pattern``.
ALLOWED_FILE_RE_V01 = re.compile(
    r"(agent\.(yml|yaml|json)|README\.md|smoke\.(model|expected)\.jsonl|user\.answers\.jsonl|"
    r"deployment\.[A-Za-z0-9._-]+\.ya?ml)"
)
ALLOWED_FILE_RE_V02 = re.compile(
    r"(agent\.(yml|yaml|json)|README\.md|smoke\.(model|expected)\.jsonl|user\.answers\.jsonl|"
    r"deployment\.[A-Za-z0-9._-]+\.ya?ml|connectors\.(yml|yaml|json)|connectors/[A-Za-z0-9._-]+\.(yml|yaml|json))"
)
ALLOWED_FILE_RE_V03 = re.compile(
    r"(agent\.(yml|yaml|json)|README\.md|smoke\.(model|expected)\.jsonl|user\.answers\.jsonl|mcp\.recorded\.jsonl|"
    r"module\.recorded\.jsonl|deployment\.[A-Za-z0-9._-]+\.ya?ml|connectors\.(yml|yaml|json)|"
    r"connectors/[A-Za-z0-9._-]+\.(yml|yaml|json)|connectors/mcp/[A-Za-z0-9._-]+\.json|"
    r"connectors/module/[A-Za-z0-9._-]+\.(json|yml|yaml|mjs))"
)
NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
HEX64_RE = re.compile(r"[a-f0-9]{64}")

TOP_LEVEL_V01 = frozenset({"format", "name", "files", "signature"})
TOP_LEVEL_V02 = frozenset({"format", "name", "files", "resolved", "resolved_sha256", "signature"})
FILE_BACKED_LOCK_KINDS = frozenset({"file", "mcp", "module"})
POLICY_CODES = frozenset({"bundle_unsigned", "bundle_signature_untrusted"})

_LONE_SURROGATE_RE = re.compile(r"[\ud800-\udfff]")


class BundleError(Exception):
    """Closed codes: bundle_invalid, bundle_path, bundle_too_large, bundle_unknown_entry,
    bundle_resolved_hash_mismatch, bundle_resolved_mismatch, bundle_lock_file_missing,
    bundle_lock_hash_mismatch, bundle_signature_invalid, bundle_signature_unsupported,
    bundle_signature_untrusted, bundle_unsigned, bundle_trust_store_invalid, not_found."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def is_bundle_path(path: str | Path) -> bool:
    return str(path).endswith(".fausth.json")


def is_harness_bundle_v2(bundle: dict[str, Any]) -> bool:
    return bundle.get("format") in (BUNDLE_FORMAT_V02, BUNDLE_FORMAT_V03)


def assert_safe_bundle_entry_name(name: str, format: str = BUNDLE_FORMAT_V01) -> None:
    if not name or not isinstance(name, str):
        raise BundleError("bundle_path", "empty bundle entry name")
    if "\0" in name:
        raise BundleError("bundle_path", "bundle entry contains NUL")
    if "\\" in name:
        raise BundleError("bundle_path", f"backslash paths forbidden: {name}")
    if re.match(r"[a-zA-Z]:", name) or name.startswith("~") or name.startswith("/"):
        raise BundleError("bundle_path", f"absolute/drive bundle path: {name}")
    if len(name) > BUNDLE_MAX_ENTRY_NAME:
        raise BundleError("bundle_path", f"bundle entry name too long: {name[:64]}…")
    parts = name.split("/")
    if any(p in ("", ".", "..", ".git") for p in parts):
        raise BundleError("bundle_path", f"unsafe bundle path: {name}")
    if format == BUNDLE_FORMAT_V01:
        if "/" in name:
            raise BundleError("bundle_path", f"unsafe bundle path: {name}")
        if not ALLOWED_FILE_RE_V01.fullmatch(name):
            raise BundleError("bundle_unknown_entry", f"unknown or disallowed bundle entry: {name}")
        return
    if format == BUNDLE_FORMAT_V02:
        if not ALLOWED_FILE_RE_V02.fullmatch(name):
            raise BundleError("bundle_unknown_entry", f"unknown or disallowed bundle entry: {name}")
        return
    if format == BUNDLE_FORMAT_V03:
        if not ALLOWED_FILE_RE_V03.fullmatch(name):
            raise BundleError("bundle_unknown_entry", f"unknown or disallowed bundle entry: {name}")
        return
    raise BundleError("bundle_invalid", f"unknown bundle format for path check: {format}")


def _canonical_numbers(value: Any, path: str = "$") -> Any:
    """D3 at the bundle entry: integral numbers become int53 ints, anything else is rejected."""
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, int):
        if value < INT53_MIN or value > INT53_MAX:
            raise BundleError("bundle_invalid", f"integer out of portable int53 range at {path}")
        return value
    if isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            raise BundleError("bundle_invalid", f"non-canonical (non-integral) number at {path}")
        return _canonical_numbers(int(value), path)
    if isinstance(value, list):
        return [_canonical_numbers(v, f"{path}[{i}]") for i, v in enumerate(value)]
    if isinstance(value, dict):
        return {k: _canonical_numbers(v, f"{path}.{k}") for k, v in value.items()}
    raise BundleError("bundle_invalid", f"unsupported value type at {path}: {type(value).__name__}")


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
        if _LONE_SURROGATE_RE.search(content):
            raise BundleError("bundle_invalid", f"file content is not well-formed Unicode: {key}")
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
    if not isinstance(raw["resolution"].get("lock"), list):
        raise BundleError("bundle_invalid", "bundle.resolved.resolution.lock must be an array")
    return raw


def verify_bundle_integrity(bundle: dict[str, Any]) -> None:
    """Resolved hash + file/mcp/module lock pins against the embedded files."""
    resolved = bundle["resolved"]
    expected = resolved_harness_hash(resolved)
    got = bundle.get("resolved_sha256")
    if got != expected:
        raise BundleError(
            "bundle_resolved_hash_mismatch",
            f"resolved_sha256 mismatch: expected {expected}, got {got}",
        )
    for lock in resolved.get("resolution", {}).get("lock", []):
        if not isinstance(lock, dict):
            raise BundleError("bundle_invalid", "resolved lock entry must be an object")
        kind = lock.get("kind")
        if kind == "inline":
            continue
        if kind not in FILE_BACKED_LOCK_KINDS:
            raise BundleError(
                "bundle_invalid",
                f"unsupported connector kind in resolved lock: {kind!r}",
            )
        path = lock.get("path")
        if not path:
            raise BundleError("bundle_lock_file_missing", f"{kind} lock entry missing path")
        assert_safe_bundle_entry_name(path, bundle["format"])
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


def _write_bundle_files(b: dict[str, Any], dest: Path) -> None:
    for name in b["files"]:
        assert_safe_bundle_entry_name(name, b["format"])
    for name, content in b["files"].items():
        target = dest / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content.encode("utf-8"))


def verify_resolved_matches_sources(bundle: dict[str, Any]) -> None:
    """Re-resolve the shipped sources in a private temp dir; must equal the embedded IR."""
    tmp = Path(tempfile.mkdtemp(prefix="fausth-reresolve-"))
    try:
        _write_bundle_files(bundle, tmp)
        try:
            from_sources = resolved_harness_hash(resolve_harness(tmp))
        except Exception as e:  # any resolve failure means the sources do not back the IR
            raise BundleError(
                "bundle_resolved_mismatch", f"shipped sources do not resolve: {e}"
            ) from e
        if from_sources != bundle["resolved_sha256"]:
            raise BundleError(
                "bundle_resolved_mismatch",
                "embedded resolved IR does not match the shipped sources: sources resolve to "
                f"{from_sources}, bundle declares {bundle['resolved_sha256']}",
            )
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _resolve_trust_store(trusted_keys: str | Path | dict[str, Any] | None) -> dict[str, Any] | None:
    try:
        if trusted_keys is None:
            return trust_store_from_env()
        if isinstance(trusted_keys, dict):
            return trusted_keys
        return load_trust_store(trusted_keys)
    except BundleSignatureError as e:
        raise BundleError("bundle_trust_store_invalid", str(e)) from e


def _require_trusted(require_trusted: bool | None) -> bool:
    return require_trusted_from_env() if require_trusted is None else bool(require_trusted)


def _classify_or_raise(raw: dict[str, Any], store: dict[str, Any] | None) -> dict[str, str]:
    try:
        return classify_bundle_trust(raw, store)
    except BundleSignatureError as e:
        code = (
            "bundle_signature_unsupported"
            if e.code == "bundle_signature_unsupported"
            else "bundle_signature_invalid"
        )
        raise BundleError(code, str(e)) from e
    except ValueError as e:  # canonical_json on non-canonical content
        raise BundleError("bundle_invalid", str(e)) from e


def _enforce_trust_policy(trust: dict[str, str], require_trusted: bool) -> None:
    if not require_trusted or trust["status"] == "signed-trusted":
        return
    if trust["status"] == "unsigned":
        raise BundleError(
            "bundle_unsigned",
            "unsigned bundle rejected: trusted signature required "
            "(FAUSTH_REQUIRE_TRUSTED_BUNDLES / requireTrusted)",
        )
    raise BundleError(
        "bundle_signature_untrusted",
        f"bundle signed by untrusted key {trust.get('public_key')}: not in the trusted keys store",
    )


def _verify_bundle_object(
    raw: Any,
    *,
    trusted_keys: str | Path | dict[str, Any] | None,
    require_trusted: bool | None,
    enforce_policy: bool,
) -> tuple[dict[str, Any], dict[str, str]]:
    """Order: shape → signature (tamper) → integrity → re-resolution → trust policy."""
    if not isinstance(raw, dict):
        raise BundleError("bundle_invalid", "bundle must be an object")
    raw = _canonical_numbers(raw)
    format_ = raw.get("format")
    if format_ not in (BUNDLE_FORMAT_V01, BUNDLE_FORMAT_V02, BUNDLE_FORMAT_V03):
        raise BundleError(
            "bundle_invalid",
            f"expected format {BUNDLE_FORMAT_V01}, {BUNDLE_FORMAT_V02}, or {BUNDLE_FORMAT_V03}, "
            f"got {format_!r}",
        )
    allowed_top = TOP_LEVEL_V01 if format_ == BUNDLE_FORMAT_V01 else TOP_LEVEL_V02
    for k in raw:
        if k not in allowed_top:
            if format_ == BUNDLE_FORMAT_V01 and k in ("resolved", "resolved_sha256"):
                raise BundleError("bundle_invalid", "v0.1 bundle must not include resolved fields")
            raise BundleError("bundle_invalid", f"unknown top-level bundle field: {k}")
    name = raw.get("name")
    if not isinstance(name, str) or not name:
        raise BundleError("bundle_invalid", "bundle.name must be a non-empty string")
    if not NAME_RE.fullmatch(name):
        raise BundleError("bundle_invalid", "bundle.name has invalid characters")
    files = _validate_files_map(raw.get("files"), format_)
    store = _resolve_trust_store(trusted_keys)

    if format_ == BUNDLE_FORMAT_V01:
        bundle: dict[str, Any] = {"format": BUNDLE_FORMAT_V01, "name": name, "files": files}
    else:
        resolved_sha256 = raw.get("resolved_sha256")
        if not isinstance(resolved_sha256, str) or not HEX64_RE.fullmatch(resolved_sha256):
            raise BundleError(
                "bundle_invalid",
                "bundle.resolved_sha256 must be a 64-char lowercase hex string",
            )
        resolved = _validate_resolved_object(raw.get("resolved"))
        bundle = {
            "format": format_,
            "name": name,
            "files": files,
            "resolved": resolved,
            "resolved_sha256": resolved_sha256,
        }

    trust = _classify_or_raise(raw, store)
    if trust["status"] != "unsigned":
        bundle["signature"] = raw["signature"]
    if is_harness_bundle_v2(bundle):
        verify_bundle_integrity(bundle)
        verify_resolved_matches_sources(bundle)
    if enforce_policy:
        _enforce_trust_policy(trust, _require_trusted(require_trusted))
    return bundle, trust


def validate_bundle(
    raw: Any,
    *,
    trusted_keys: str | Path | dict[str, Any] | None = None,
    require_trusted: bool | None = None,
) -> dict[str, Any]:
    """Validate a bundle object (signature, integrity, re-resolution, trust policy)."""
    bundle, _ = _verify_bundle_object(
        raw, trusted_keys=trusted_keys, require_trusted=require_trusted, enforce_policy=True
    )
    return bundle


def verify_bundle(
    raw: Any,
    *,
    trusted_keys: str | Path | dict[str, Any] | None = None,
    require_trusted: bool | None = None,
) -> tuple[dict[str, Any], dict[str, str]]:
    """Like validate_bundle but also returns the trust classification."""
    return _verify_bundle_object(
        raw, trusted_keys=trusted_keys, require_trusted=require_trusted, enforce_policy=True
    )


def assert_loadable_bundle(raw: Any) -> None:
    """Pack-side self check: loader rules minus the trust policy."""
    _verify_bundle_object(raw, trusted_keys=None, require_trusted=False, enforce_policy=False)


def _reject_constant(name: str) -> Any:
    raise BundleError("bundle_invalid", f"invalid JSON: non-finite number {name}")


def _read_bundle_json(path: str | Path) -> Any:
    p = Path(path).resolve()
    if not p.is_file():
        raise BundleError("not_found", f"bundle not found: {p}")
    try:
        text = p.read_bytes().decode("utf-8")
    except UnicodeDecodeError as e:
        raise BundleError("bundle_invalid", f"bundle is not valid UTF-8: {p}") from e
    try:
        return json.loads(text, parse_constant=_reject_constant)
    except json.JSONDecodeError as e:
        raise BundleError("bundle_invalid", f"invalid JSON: {e}") from e


def load_verified_bundle_file(
    path: str | Path,
    *,
    trusted_keys: str | Path | dict[str, Any] | None = None,
    require_trusted: bool | None = None,
) -> tuple[dict[str, Any], dict[str, str]]:
    return _verify_bundle_object(
        _read_bundle_json(path),
        trusted_keys=trusted_keys,
        require_trusted=require_trusted,
        enforce_policy=True,
    )


def load_bundle_file(
    path: str | Path,
    *,
    trusted_keys: str | Path | dict[str, Any] | None = None,
    require_trusted: bool | None = None,
) -> dict[str, Any]:
    bundle, _ = load_verified_bundle_file(
        path, trusted_keys=trusted_keys, require_trusted=require_trusted
    )
    return bundle


def verify_bundle_file(
    path: str | Path,
    *,
    trusted_keys: str | Path | dict[str, Any] | None = None,
    require_trusted: bool | None = None,
) -> dict[str, Any]:
    """CLI-facing report; never raises for bundle problems (mirrors TS verifyBundleFile).

    exit_code: 0 accepted; 1 invalid/tampered/unreadable; 2 trust-store configuration
    error; 3 intact bundle rejected by the trust policy.
    """
    p = str(Path(path).resolve())
    req = _require_trusted(require_trusted)
    try:
        bundle, trust = _verify_bundle_object(
            _read_bundle_json(p),
            trusted_keys=trusted_keys,
            require_trusted=req,
            enforce_policy=False,
        )
    except BundleError as e:
        return {
            "ok": False,
            "exit_code": 2 if e.code == "bundle_trust_store_invalid" else 1,
            "path": p,
            "require_trusted": req,
            "error": {"code": e.code, "message": str(e)},
        }
    report: dict[str, Any] = {
        "path": p,
        "format": bundle["format"],
        "status": trust["status"],
        "require_trusted": req,
    }
    if trust.get("public_key"):
        report["public_key"] = trust["public_key"]
    if trust.get("key_label"):
        report["key_label"] = trust["key_label"]
    try:
        _enforce_trust_policy(trust, req)
    except BundleError as e:
        if e.code in POLICY_CODES:
            return {**report, "ok": False, "exit_code": 3, "error": {"code": e.code, "message": str(e)}}
        raise
    return {**report, "ok": True, "exit_code": 0}


def format_bundle_verify_report(r: dict[str, Any]) -> str:
    """One-line summary; identical text to TS formatBundleVerifyReport."""
    err = r.get("error") or {}
    if r["exit_code"] in (1, 2):
        return f"INVALID {err.get('code', 'bundle_invalid')}: {err.get('message', '')}"
    signer = f" ed25519 public_key={r['public_key']}" if r.get("public_key") else ""
    label = f" key_label={r['key_label']}" if r.get("key_label") else ""
    if r["exit_code"] == 3:
        return f"REJECTED {r.get('status')}{signer} ({r.get('format')}): {err.get('message', '')}"
    return f"OK {r.get('status')}{signer}{label} ({r.get('format')})"


def unpack_bundle(
    bundle: dict[str, Any] | str | Path,
    out_dir: str | Path,
    *,
    force: bool = False,
    trusted_keys: str | Path | dict[str, Any] | None = None,
    require_trusted: bool | None = None,
) -> Path:
    if isinstance(bundle, dict):
        b = validate_bundle(bundle, trusted_keys=trusted_keys, require_trusted=require_trusted)
    else:
        b = load_bundle_file(bundle, trusted_keys=trusted_keys, require_trusted=require_trusted)
    dest = Path(out_dir).resolve()
    if dest.exists():
        if any(dest.iterdir()) and not force:
            raise BundleError("bundle_invalid", f"output directory not empty: {dest} (pass --force)")
    else:
        dest.mkdir(parents=True, exist_ok=True)
    _write_bundle_files(b, dest)
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
        trust: dict[str, str] | None = None,
    ) -> None:
        self.kind = kind
        self.harness_dir = harness_dir
        self.source = source
        self.bundle_format = bundle_format
        self.embedded_resolved = embedded_resolved
        self.trust = trust
        self._cleanup = cleanup

    def cleanup(self) -> None:
        self._cleanup()


def resolve_harness_ref(
    ref: str | Path,
    *,
    trusted_keys: str | Path | dict[str, Any] | None = None,
    require_trusted: bool | None = None,
) -> ResolvedHarness:
    """Directory or bundle → harness dir. Bundle dirs are registered with the provenance
    registry so host adapters can refuse bundle-declared commands (PY-3)."""
    abs_path = Path(ref).resolve()
    if not abs_path.exists():
        raise BundleError("not_found", f"harness not found: {abs_path}")
    if abs_path.is_dir():
        return ResolvedHarness("dir", abs_path, abs_path, lambda: None)
    if abs_path.is_file() and is_bundle_path(abs_path):
        loaded, trust = load_verified_bundle_file(
            abs_path, trusted_keys=trusted_keys, require_trusted=require_trusted
        )
        tmp = Path(tempfile.mkdtemp(prefix="fausth-bundle-"))
        try:
            _write_bundle_files(loaded, tmp)
        except Exception:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        info: dict[str, Any] = {
            "bundle": str(abs_path),
            "format": loaded["format"],
            "trust": trust["status"],
        }
        if trust.get("public_key"):
            info["public_key"] = trust["public_key"]
        register_bundle_dir(tmp, info)

        def _cleanup() -> None:
            unregister_bundle_dir(tmp)
            shutil.rmtree(tmp, ignore_errors=True)

        return ResolvedHarness(
            "bundle",
            tmp,
            abs_path,
            _cleanup,
            bundle_format=loaded["format"],
            embedded_resolved=loaded["resolved"] if is_harness_bundle_v2(loaded) else None,
            trust=trust,
        )
    raise BundleError(
        "bundle_invalid",
        f"expected harness directory or .fausth.json bundle, got: {abs_path.name}",
    )


def bundle_canonical_json(bundle: dict[str, Any]) -> str:
    return canonical_json(bundle) + "\n"
