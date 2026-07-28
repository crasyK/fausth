"""Shared adapter error type for Python engine."""
from __future__ import annotations

AdapterErrorCode = str  # binding_missing | adapter_unresolved


class AdapterError(Exception):
    def __init__(self, code: AdapterErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code
