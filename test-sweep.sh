#!/usr/bin/env bash
# Simulation sweep — calls the sim number, waits, pulls transcripts.
# Usage: ./test-sweep.sh [label]
set -euo pipefail

LABEL="${1:-default}"
SIM_NUMBER="+14706258591"
URL="${CALL_OPS_URL:-https://anja-unpetulant-pseudoapologetically.ngrok-free.dev}"
WAIT_SECS="${WAIT_SECS:-25}"

echo "[$LABEL] Calling $SIM_NUMBER via $URL..."

# Place outbound call
RESULT=$(curl -s -X POST "$URL/call/outbound" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg to "$SIM_NUMBER" '{to: $to}')")

SESSION_ID=$(echo "$RESULT" | jq -r '.callSessionId // empty')
if [ -z "$SESSION_ID" ]; then
  echo "[$LABEL] FAILED to place call: $RESULT"
  exit 1
fi

echo "[$LABEL] Call placed: session=$SESSION_ID"
echo "[$LABEL] Waiting ${WAIT_SECS}s for call to complete..."
sleep "$WAIT_SECS"

# Pull transcripts
echo "[$LABEL] Fetching transcripts..."
TRANSCRIPTS=$(curl -s "$URL/call/$SESSION_ID/state" | jq '.transcripts')

if [ "$TRANSCRIPTS" = "null" ] || [ "$TRANSCRIPTS" = "[]" ]; then
  echo "[$LABEL] No transcripts found."
  exit 1
fi

# Display turn-by-turn comparison
echo ""
echo "=== [$LABEL] TRANSCRIPT COMPARISON ==="
echo "$TRANSCRIPTS" | python3 -c "
import sys, json

txs = json.load(sys.stdin)

# Group consecutive same-source entries
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
echo ""
echo "=== [$LABEL] DONE ==="
