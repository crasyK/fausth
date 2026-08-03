#!/usr/bin/env bash
# Track S measurement chain: django smoke then sequential SWE opt-arms v3.
set -euo pipefail
cd "$(dirname "$0")/.."
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use >/dev/null 2>&1 || true
[ -f .venv/bin/activate ] && . .venv/bin/activate
set -a; [ -f .env ] && . ./.env; set +a

LOG=live/reports/kit-probe/track-s-measure.log
mkdir -p live/reports/kit-probe

echo "[measure] django smoke cb-budget django-10914" | tee -a "$LOG"
set -o pipefail
node scripts/case-study-coding.mjs --mode live \
  --manifest case-studies/swe-bench/manifest-optimize.yml \
  --conditions cb-budget \
  --kit-models kit.gemma4-31b-it \
  --reps 1 \
  --run-id hri-swe-django10914-levers-v2 \
  --tasks django__django-10914 \
  --soft-retry-plan \
  --skip-conformance 2>&1 | tee -a live/reports/kit-probe/hri-swe-django10914-levers-v2.log
DJANGO_EXIT=${PIPESTATUS[0]}
echo "DJANGO_EXIT:$DJANGO_EXIT" | tee -a "$LOG"

if [ -f live/reports/case-studies/swe-bench/hri-swe-django10914-levers-v2/summary.json ]; then
  cp live/reports/case-studies/swe-bench/hri-swe-django10914-levers-v2/summary.json \
    case-studies/swe-bench/results/hri-swe-django10914-levers-v2.summary.json
fi

echo "[measure] sequential opt-arms v3 SWE" | tee -a "$LOG"
export OPT_ARMS_RUN_PREFIX=v3
node scripts/opt-arms-sequential.mjs launch
echo "MEASURE_CHAIN_LAUNCHED" | tee -a "$LOG"
