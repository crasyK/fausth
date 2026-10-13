"""Optional Ed25519 detached signatures for harness bundles (M10.4).

Covered bytes: UTF-8 of canonical_json(bundle without ``signature``).
Signature object: ``{alg: "ed25519", public_key: hex32, sig: hex64}``.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Mapping

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from .canonical import canonical_json

BUNDLE_SIG_ALG = "ed25519"

#: Env var naming a trusted-keys file (one Ed25519 public key per line).
TRUSTED_KEYS_ENV = "FAUSTH_TRUSTED_KEYS"
#: Env var that, when "1"/"true", rejects unsigned and signed-untrusted bundles.
REQUIRE_TRUSTED_ENV = "FAUSTH_REQUIRE_TRUSTED_BUNDLES"

TRUST_LINE_RE = re.compile(r"([0-9a-fA-F]{64})(?:\s+(.+))?")

HEX32_RE = re.compile(r"^[a-f0-9]{64}$")
HEX64_RE = re.compile(r"^[a-f0-9]{128}$")


class BundleSignatureError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def signing_payload(bundle: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in bundle.items() if k != "signature"}


def signing_bytes(bundle: dict[str, Any]) -> bytes:
    return canonical_json(signing_payload(bundle)).encode("utf-8")


def parse_bundle_signature(raw: Any) -> dict[str, str]:
    if not isinstance(raw, dict):
        raise BundleSignatureError("bundle_signature_invalid", "bundle.signature must be an object")
    alg = raw.get("alg")
    if alg != BUNDLE_SIG_ALG:
        raise BundleSignatureError(
            "bundle_signature_unsupported",
            f"unsupported signature alg: {alg!r}",
        )
    public_key = raw.get("public_key")
    if not isinstance(public_key, str) or not HEX32_RE.fullmatch(public_key):
        raise BundleSignatureError(
            "bundle_signature_invalid",
            "bundle.signature.public_key must be 64-char lowercase hex (32-byte Ed25519 key)",
        )
    sig = raw.get("sig")
    if not isinstance(sig, str) or not HEX64_RE.fullmatch(sig):
        raise BundleSignatureError(
            "bundle_signature_invalid",
            "bundle.signature.sig must be 128-char lowercase hex (64-byte Ed25519 signature)",
        )
    allowed = {"alg", "public_key", "sig"}
    for k in raw:
        if k not in allowed:
            raise BundleSignatureError(
                "bundle_signature_invalid",
                f"unexpected signature field: {k}",
            )
    return {"alg": BUNDLE_SIG_ALG, "public_key": public_key, "sig": sig}


def verify_bundle_signature(bundle: dict[str, Any]) -> None:
    """Verify the detached signature when present (a JSON ``null`` signature is invalid)."""
    if "signature" not in bundle:
        return
    signature = parse_bundle_signature(bundle["signature"])
    pub = Ed25519PublicKey.from_public_bytes(bytes.fromhex(signature["public_key"]))
    try:
        pub.verify(bytes.fromhex(signature["sig"]), signing_bytes(bundle))
    except InvalidSignature as e:
        raise BundleSignatureError(
            "bundle_signature_invalid",
            "bundle signature verification failed",
        ) from e


def parse_trust_store(text: str, source: str | None = None) -> dict[str, Any]:
    """Parse a trusted-keys file (mirrors TS parseTrustStore).

    One 64-hex Ed25519 public key per line, optional label after whitespace;
    ``#`` comment lines and blank lines are ignored; any other line is rejected.
    Returns ``{"keys": {public_key: {"public_key", "label"?}}, "source"?: str}``.
    """
    keys: dict[str, dict[str, str]] = {}
    if text.startswith("\ufeff"):
        text = text[1:]
    for i, raw in enumerate(re.split(r"\r?\n", text)):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = TRUST_LINE_RE.fullmatch(line)
        if not m:
            raise BundleSignatureError(
                "bundle_trust_store_invalid",
                f"{source or 'trusted keys'}:{i + 1}: expected '<64-hex ed25519 public key> [label]'",
            )
        public_key = m.group(1).lower()
        label = (m.group(2) or "").strip()
        if public_key not in keys:
            keys[public_key] = (
                {"public_key": public_key, "label": label} if label else {"public_key": public_key}
            )
    store: dict[str, Any] = {"keys": keys}
    if source:
        store["source"] = source
    return store


def load_trust_store(path: str | Path) -> dict[str, Any]:
    """Load a trusted-keys file; missing/unreadable → error (fail closed)."""
    p = Path(path).resolve()
    if not p.is_file():
        raise BundleSignatureError("bundle_trust_store_invalid", f"trusted keys file not found: {p}")
    try:
        text = p.read_bytes().decode("utf-8")
    except UnicodeDecodeError as e:
        raise BundleSignatureError(
            "bundle_trust_store_invalid", f"trusted keys file is not valid UTF-8: {p}"
        ) from e
    return parse_trust_store(text, str(p))


def trust_store_from_env(env: Mapping[str, str] | None = None) -> dict[str, Any] | None:
    """Trust store named by FAUSTH_TRUSTED_KEYS (a file path); None when unset."""
    e = os.environ if env is None else env
    p = (e.get(TRUSTED_KEYS_ENV) or "").strip()
    return load_trust_store(p) if p else None


def require_trusted_from_env(env: Mapping[str, str] | None = None) -> bool:
    e = os.environ if env is None else env
    return (e.get(REQUIRE_TRUSTED_ENV) or "").strip().lower() in ("1", "true")


def classify_bundle_trust(bundle: dict[str, Any], store: dict[str, Any] | None = None) -> dict[str, str]:
    """Verify the signature (raises on invalid) and classify against the trust store.

    Returns ``{"status": "unsigned"|"signed-untrusted"|"signed-trusted",
    "public_key"?: hex, "key_label"?: str}``.
    """
    if "signature" not in bundle:
        return {"status": "unsigned"}
    verify_bundle_signature(bundle)
    signature = parse_bundle_signature(bundle["signature"])
    hit = ((store or {}).get("keys") or {}).get(signature["public_key"])
    if not hit:
        return {"status": "signed-untrusted", "public_key": signature["public_key"]}
    out = {"status": "signed-trusted", "public_key": signature["public_key"]}
    if hit.get("label"):
        out["key_label"] = hit["label"]
    return out


def _private_key_from_seed(seed: bytes) -> Ed25519PrivateKey:
    if len(seed) != 32:
        raise BundleSignatureError(
            "bundle_sign_key_invalid",
            f"Ed25519 seed must be 32 bytes, got {len(seed)}",
        )
    return Ed25519PrivateKey.from_private_bytes(seed)


def load_sign_key_material(input: str | bytes | Path) -> Ed25519PrivateKey:
    if isinstance(input, Path):
        return load_sign_key_material(input.read_bytes())
    if isinstance(input, str):
        trimmed = input.strip()
        if "BEGIN" in trimmed and "PRIVATE KEY" in trimmed:
            key = serialization.load_pem_private_key(trimmed.encode("utf-8"), password=None)
            if not isinstance(key, Ed25519PrivateKey):
                raise BundleSignatureError(
                    "bundle_sign_key_invalid",
                    "PEM key must be an Ed25519 private key",
                )
            return key
        hex_body = re.sub(r"\s+", "", trimmed).lower()
        if HEX32_RE.fullmatch(hex_body):
            return _private_key_from_seed(bytes.fromhex(hex_body))
        path = Path(trimmed)
        if path.is_file():
            return load_sign_key_material(path.read_bytes())
        raise BundleSignatureError(
            "bundle_sign_key_invalid",
            f"sign key path not found or invalid material: {trimmed}",
        )

    text = input.decode("utf-8", errors="ignore").strip()
    if "BEGIN" in text and "PRIVATE KEY" in text:
        key = serialization.load_pem_private_key(text.encode("utf-8"), password=None)
        if not isinstance(key, Ed25519PrivateKey):
            raise BundleSignatureError(
                "bundle_sign_key_invalid",
                "PEM key must be an Ed25519 private key",
            )
        return key
    hex_body = re.sub(r"\s+", "", text).lower()
    if HEX32_RE.fullmatch(hex_body):
        return _private_key_from_seed(bytes.fromhex(hex_body))
    if len(input) == 32:
        return _private_key_from_seed(input)
    try:
        key = serialization.load_der_private_key(input, password=None)
        if not isinstance(key, Ed25519PrivateKey):
            raise BundleSignatureError(
                "bundle_sign_key_invalid",
                "DER key must be an Ed25519 private key",
            )
        return key
    except BundleSignatureError:
        raise
    except Exception as e:
        raise BundleSignatureError(
            "bundle_sign_key_invalid",
            "sign key must be 32-byte seed (raw or 64-hex), or PKCS8 PEM/DER Ed25519 private key",
        ) from e


def load_sign_key_from_path(path: str | Path) -> Ed25519PrivateKey:
    return load_sign_key_material(Path(path))


def _raw_public_hex(private_key: Ed25519PrivateKey) -> str:
    return (
        private_key.public_key()
        .public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
        .hex()
    )


def sign_bundle(
    bundle: dict[str, Any],
    private_key: Ed25519PrivateKey | str | bytes | Path,
) -> dict[str, Any]:
    if not isinstance(private_key, Ed25519PrivateKey):
        key = load_sign_key_material(private_key)
    else:
        key = private_key
    unsigned = signing_payload(bundle)
    sig = key.sign(canonical_json(unsigned).encode("utf-8"))
    return {
        **unsigned,
        "signature": {
            "alg": BUNDLE_SIG_ALG,
            "public_key": _raw_public_hex(key),
            "sig": sig.hex(),
        },
    }


def generate_ed25519_seed_hex() -> dict[str, str]:
    key = Ed25519PrivateKey.generate()
    seed = key.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    return {"seed_hex": seed.hex(), "public_key": _raw_public_hex(key)}
