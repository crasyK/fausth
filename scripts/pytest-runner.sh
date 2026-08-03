#!/usr/bin/env bash
# Resolve Fausth repo .venv pytest for SWE-bench shell cmd=test (cwd is task worktree).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTEST="${ROOT}/.venv/bin/pytest"
if [[ ! -x "$PYTEST" ]]; then
  PYTEST="$(command -v pytest 2>/dev/null || true)"
fi
if [[ -z "${PYTEST:-}" || ! -x "$PYTEST" ]]; then
  echo "pytest not found (checked ${ROOT}/.venv/bin/pytest and PATH)" >&2
  exit 127
fi
exec "$PYTEST" "$@"
