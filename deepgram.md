# Deepgram Flux VAD — Notes

## Current Setup
- Model: `flux-general-en` on `wss://api.deepgram.com/v2/listen`
- Encoding: mulaw 8kHz (raw from Telnyx, no conversion)
- EOT threshold: 0.8, EOT timeout: 3000ms
- Eager EOT threshold: 0.5

## Turn Detection Flow
We use only `EndOfTurn` events to signal `activityEnd` to Gemini. A 200ms flush delay is applied before signaling so in-flight audio packets from Telnyx reach Gemini before it stops listening.

## EagerEndOfTurn — Not Used Yet
Deepgram Flux provides `EagerEndOfTurn` at a lower confidence threshold (0.5) before the final `EndOfTurn` (0.8). This could be used to:
- Signal `activityEnd` sooner for faster Gemini response latency
- Use the confidence-based early exit in the `Update` handler (check `end_of_turn_confidence` on first turn)

Production repo uses a 0.6 threshold on first-turn `Update` events to exit early. We removed this for simplicity — revisit if latency is a problem.

## Flux Events Reference
| Event | Meaning |
|-------|---------|
| `StartOfTurn` | Speech detected — signal `activityStart` to Gemini |
| `Update` | Ongoing speech — carries partial transcript + EOT confidence |
| `EagerEndOfTurn` | High-ish confidence speech ended (0.5) — could act early |
| `TurnResumed` | User kept talking after an eager EOT — re-signal `activityStart` |
| `EndOfTurn` | Confident speech ended (0.8) — signal `activityEnd` to Gemini |
