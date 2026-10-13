#!/usr/bin/env bash
# Track S measurement chain: django smoke, then sequential SWE opt-arms.
#
# The smoke's status is recorded but never aborts the chain (a failing smoke used
# to kill the script under `set -e` before DJANGO_EXIT was read, so the opt-arms
# never launched). Results stay under live/reports/; promote explicitly with
# scripts/promote-run.mjs. The script exits with the smoke's status.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 97
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; nvm use >/dev/null 2>&1 || true; fi
if [ -f .venv/bin/activate ]; then . .venv/bin/activate; fi
set -a; if [ -f .env ]; then . ./.env; fi; set +a

KIT_MODEL="${KIT_MODEL:-kit.glm-5.3-flash}"
RUN_ID="${DJANGO_RUN_ID:-hri-swe-django10914-levers-v3}"
LOG=live/reports/kit-probe/track-s-measure.log
mkdir -p live/reports/kit-probe

echo "[measure] django smoke cb-budget django-10914 (${KIT_MODEL})" | tee -a "$LOG"
node scripts/case-study-coding.mjs --mode live \
  --manifest case-studies/swe-bench/manifest-optimize.yml \
  --conditions cb-budget \
  --kit-models "$KIT_MODEL" \
  --reps 1 \
  --run-id "$RUN_ID" \
  --tasks django__django-10914 \
  --soft-retry-plan \
  --skip-conformance 2>&1 | tee -a "live/reports/kit-probe/${RUN_ID}.log"
DJANGO_EXIT=${PIPESTATUS[0]}
echo "DJANGO_EXIT:${DJANGO_EXIT}" | tee -a "$LOG"
echo "[measure] summary: live/reports/case-studies/swe-bench/${RUN_ID}/summary.json (promote with scripts/promote-run.mjs)" | tee -a "$LOG"

echo "[measure] sequential opt-arms SWE" | tee -a "$LOG"
export OPT_ARMS_RUN_PREFIX="${OPT_ARMS_RUN_PREFIX:-v3}"
export OPT_ARMS_KIT_MODEL="$KIT_MODEL"
if node scripts/opt-arms-sequential.mjs launch; then
  echo "MEASURE_CHAIN_LAUNCHED" | tee -a "$LOG"
else
  echo "MEASURE_CHAIN_LAUNCH_FAILED" | tee -a "$LOG"
  exit 1
fi
exit "$DJANGO_EXIT"
