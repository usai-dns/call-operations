# Deepgram Flux VAD — Notes

## Current Setup
- Model: `flux-general-en` on `wss://api.deepgram.com/v2/listen`
- Encoding: `linear16` (L16 PCM from Telnyx, passthrough — no conversion)
- Sample rate: 8000 Hz
- EOT threshold: 0.8, EOT timeout: 3000ms
- Eager EOT threshold: 0.5

## Role in Architecture
Deepgram is the **turn boundary detector**. It signals `activityStart` and `activityEnd` to Gemini via manual VAD. It also provides transcript comparison against Gemini's built-in transcription.

Deepgram receives audio continuously — even during AI speech — for barge-in detection. It does NOT false-trigger on echo (confirmed through testing).

## Turn Detection Flow
1. `StartOfTurn` → signal `activityStart` to Gemini, flush rolling buffer
2. Audio flows to Gemini during activity window
3. `EndOfTurn` → 200ms flush delay → signal `activityEnd` to Gemini
4. The 200ms delay lets in-flight audio packets reach Gemini before it stops listening

## Half-Duplex Interaction
- Deepgram always receives audio (for turn detection + barge-in)
- During AI speech (`geminiSpeaking=true`): if Deepgram detects speech, it's treated as barge-in
- The echo suppression bypass: `if (geminiSpeaking && deepgram.speaking)` → allow audio to Gemini

## StartOfTurn Latency
- No official latency numbers from Deepgram
- Estimated 100-300ms on clean audio, likely higher on telephony (8kHz, noise)
- This is why the rolling buffer exists — captures 300ms of pre-detection audio
- No parameters exist to tune StartOfTurn sensitivity (only end-of-turn thresholds)

## EagerEndOfTurn — Not Used Yet
Could be used for speculative early turn processing. Fires at 0.5 confidence before EndOfTurn (0.8). Trade-off: faster response vs risk of cutting off user mid-sentence.

## Flux Events Reference
| Event | Meaning | Our Action |
|-------|---------|------------|
| `StartOfTurn` | Speech detected | `activityStart` + buffer flush |
| `Update` | Ongoing speech + partial transcript | Log only |
| `EagerEndOfTurn` | Might be done (0.5 confidence) | Log only (future: speculative processing) |
| `TurnResumed` | User kept talking after eager EOT | Log only |
| `EndOfTurn` | Definitely done (0.8 confidence) | 200ms delay → `activityEnd` |

## Standalone vs Managed API
We use the standalone Flux streaming API (`/v2/listen`). Deepgram's managed Voice Agent API (`/v1/agent/converse`) has built-in echo cancellation and `AgentAudioDone` signals, but requires using their full pipeline. Standalone Flux has no echo awareness — we handle it ourselves with half-duplex suppression.
