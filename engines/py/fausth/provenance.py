"""Harness-directory provenance for the trust boundary (mirrors TS adapters/provenance.ts).

When a ``.fausth.json`` bundle is unpacked to a temp directory, the bundle loader
registers that directory here with the bundle's trust status. Host adapters consult
it before doing anything a bundle author must not be able to trigger on their own
(e.g. spawning a stdio command declared by a deployment file shipped in the bundle).
"""
from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Any

#: Three distinct outcomes of signature verification against a trust store.
TRUST_STATUSES = ("unsigned", "signed-untrusted", "signed-trusted")

_lock = threading.Lock()
_registered: dict[str, dict[str, Any]] = {}


def _canonical_dir(p: str | Path) -> str:
    try:
        return str(Path(p).resolve())
    except OSError:
        return os.path.abspath(str(p))


def register_bundle_dir(directory: str | Path, info: dict[str, Any]) -> None:
    """Record that ``directory`` holds files unpacked from a bundle.

    ``info`` keys: ``bundle`` (source path), ``format``, ``trust`` (one of
    TRUST_STATUSES) and optional ``public_key``.
    """
    trust = info.get("trust")
    if trust not in TRUST_STATUSES:
        raise ValueError(f"invalid bundle trust status: {trust!r}")
    with _lock:
        _registered[_canonical_dir(directory)] = dict(info)


def unregister_bundle_dir(directory: str | Path) -> None:
    with _lock:
        _registered.pop(_canonical_dir(directory), None)
        _registered.pop(os.path.abspath(str(directory)), None)


def bundle_provenance_for(path: str | Path | None) -> dict[str, Any] | None:
    """Provenance of ``path`` when it lies inside (or is) a registered bundle dir."""
    if not path:
        return None
    candidates = {os.path.abspath(str(path)), _canonical_dir(path)}
    with _lock:
        items = list(_registered.items())
    for c in candidates:
        for d, info in items:
            if c == d or c.startswith(d.rstrip(os.sep) + os.sep):
                return dict(info)
    return None
