#!/usr/bin/env bash
# Usage: ./test-call.sh +1XXXXXXXXXX [prompt]
set -euo pipefail

TO="${1:?Usage: ./test-call.sh <phone-number> [prompt]}"
PROMPT="${2:-You are a friendly AI assistant on a phone call. Greet the caller, ask how you can help, and have a brief conversation. When the conversation is over, use end_call.}"

URL="${CALL_OPS_URL:-http://localhost:8787}"

echo "Calling $TO via $URL..."

curl -s -X POST "$URL/call/outbound" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg to "$TO" \
    --arg prompt "$PROMPT" \
    '{to: $to, prompt: $prompt}'
  )" | jq .
