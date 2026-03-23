#!/usr/bin/env bash
# Simulation sweep — calls the sim number with different pipeline configs.
#
# Usage:
#   ./test-sweep.sh <pipeline>           # Run one pipeline mode
#   ./test-sweep.sh all                  # Run all 6 modes sequentially
#   WAIT_SECS=30 ./test-sweep.sh all     # Custom wait time
#
# Pipeline modes:
#   auto-continuous-gate, auto-continuous-raw,
#   manual-gated-buffer, manual-gated-nobuffer,
#   manual-continuous, manual-continuous-gate
set -euo pipefail

SIM_NUMBER="+14706258591"
URL="${CALL_OPS_URL:-https://anja-unpetulant-pseudoapologetically.ngrok-free.dev}"
WAIT_SECS="${WAIT_SECS:-25}"

ALL_MODES=(
  "auto-continuous-gate"
  "auto-continuous-raw"
  "manual-gated-buffer"
  "manual-gated-nobuffer"
  "manual-continuous"
  "manual-continuous-gate"
)

run_test() {
  local PIPELINE="$1"

  echo ""
  echo "━━━ [$PIPELINE] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Calling $SIM_NUMBER..."

  RESULT=$(curl -s -X POST "$URL/call/outbound" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg to "$SIM_NUMBER" --arg p "$PIPELINE" '{to: $to, pipeline: $p}')")

  SESSION_ID=$(echo "$RESULT" | jq -r '.callSessionId // empty')
  if [ -z "$SESSION_ID" ]; then
    echo "  FAILED: $RESULT"
    return 1
  fi

  echo "  session=$SESSION_ID — waiting ${WAIT_SECS}s..."
  sleep "$WAIT_SECS"

  # Pull transcripts
  STATE=$(curl -s "$URL/call/$SESSION_ID/state")
  PIPELINE_USED=$(echo "$STATE" | jq -r '.pipeline // "unknown"')
  TRANSCRIPTS=$(echo "$STATE" | jq '.transcripts')

  echo "  pipeline confirmed: $PIPELINE_USED"

  if [ "$TRANSCRIPTS" = "null" ] || [ "$TRANSCRIPTS" = "[]" ]; then
    echo "  ⚠ No transcripts"
    return 0
  fi

  echo "$TRANSCRIPTS" | python3 -c "
import sys, json

txs = json.load(sys.stdin)
turns = []
current = {}
for t in txs:
    key = f\"{t['source']}_{t['role']}\"
    if key not in current:
        current[key] = {'source': t['source'], 'role': t['role'], 'text': t['text'], 'ts': t['timestamp']}
    else:
        if t['timestamp'] - current[key]['ts'] < 2000:
            current[key]['text'] += t['text']
            current[key]['ts'] = t['timestamp']
        else:
            turns.append(current[key])
            current[key] = {'source': t['source'], 'role': t['role'], 'text': t['text'], 'ts': t['timestamp']}

for v in current.values():
    turns.append(v)
turns.sort(key=lambda x: x['ts'])

first_ts = turns[0]['ts'] if turns else 0
for t in turns:
    elapsed = (t['ts'] - first_ts) / 1000
    tag = f\"[{t['source']:>7} {t['role']:>5}]\"
    print(f'  {elapsed:6.1f}s {tag}  {t[\"text\"].strip()}')
"
}

# Main
MODE="${1:-all}"

if [ "$MODE" = "all" ]; then
  echo "Running all ${#ALL_MODES[@]} pipeline modes..."
  for m in "${ALL_MODES[@]}"; do
    run_test "$m" || true
    # Brief pause between calls to avoid rate limits
    sleep 3
  done
  echo ""
  echo "━━━ SWEEP COMPLETE ━━━"
else
  run_test "$MODE"
fi
