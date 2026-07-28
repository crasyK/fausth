"""Optional Ed25519 detached signatures for harness bundles (M10.4).

Covered bytes: UTF-8 of canonical_json(bundle without ``signature``).
Signature object: ``{alg: "ed25519", public_key: hex32, sig: hex64}``.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from .canonical import canonical_json

BUNDLE_SIG_ALG = "ed25519"

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
    if "signature" not in bundle or bundle["signature"] is None:
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
