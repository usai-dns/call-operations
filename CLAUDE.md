# Call Operations — Telnyx + Gemini Live Voice AI

## Project Overview

Real-time voice AI system bridging Telnyx telephony with Google Gemini Live API. Uses Deepgram Flux for Voice Activity Detection (VAD) and turn management. Single `CallSession` Durable Object handles all call types. Behavior driven by config-based pipeline modes.

Ported from production Twilio system (`phone-call-gemini-audio-live`). This repo replaces Twilio with Telnyx and adds L16 PCM codec support.

## Technical Stack

- **Runtime**: Cloudflare Workers with Durable Objects
- **Telephony**: Telnyx (L16 PCM 8kHz audio, Call Control API v2, WebSocket streaming)
- **Voice AI**: Google Gemini Live API (native audio, PCM 16kHz in / 24kHz out)
- **VAD**: Deepgram Flux v2 (linear16 8kHz, turn detection + transcript comparison)
- **Language**: TypeScript

## Architecture

```
CallSession (Durable Object)
  │  One class for all call types. Pipeline mode determines behavior.
  │
  ├── TelnyxService        → REST API (dial, answer, stream, hangup)
  ├── GeminiLiveService    → Gemini Live WS (manual VAD, tool calling)
  ├── DeepgramVADService   → VAD (Flux v2, linear16, turn detection)
  ├── AudioConverter       → L16 8kHz ↔ PCM 16kHz/24kHz + noise gate
  └── ToolExecutor         → Registry of tools (V1: just end_call)
```

## Audio Pipeline (manual-gated-buffer mode)

```
Telnyx WS (L16 PCM 8kHz LE base64)
  │
  ├─→ Deepgram (raw PCM bytes, always receives audio for VAD)
  │     ├─ onSpeechStarted → gemini.signalActivityStart() + flush buffer
  │     ├─ onUtteranceEnd  → gemini.signalActivityEnd() (200ms delay)
  │     └─ onEndOfTurn     → transcript comparison hook
  │
  └─→ AudioConverter.telnyxToGemini() → upsample 8kHz→16kHz
        └─→ Half-duplex check:
            [if geminiSpeaking && !deepgram.speaking] → suppress (echo)
            [if geminiSpeaking && deepgram.speaking]  → allow (barge-in)
            [if !geminiSpeaking && activityStartSignaled] → gemini.sendAudio()
            [if !geminiSpeaking && !activityStartSignaled] → rolling buffer

Gemini (PCM 24kHz LE base64)
  └─→ AudioConverter.geminiToTelnyx() → downsample 24kHz→8kHz
        └─→ Telnyx WS: {"event":"media","media":{"payload":"..."}}
```

## Pipeline Modes

Switchable via `POST /call/outbound` body: `{ "pipeline": "mode-name" }`

| Mode | VAD | Audio Flow | Buffer | Noise Gate | Status |
|------|-----|-----------|--------|------------|--------|
| `manual-gated-buffer` | Deepgram | Gated | 300ms flush | No | **Best for real phones** |
| `manual-gated-nobuffer` | Deepgram | Gated | No | No | Clean but clips onset |
| `auto-continuous-gate` | Gemini auto | Continuous | No | Yes | Fails after turn 1 on real phones |
| `auto-continuous-raw` | Gemini auto | Continuous | No | No | Best on sim, fails on real phones |
| `auto-tuned-telephony` | Gemini auto (LOW) | Continuous | No | Yes | Fails after turn 1 on real phones |
| `manual-continuous` | Deepgram | Continuous | No | No | Garbled (echo in stream) |
| `manual-continuous-gate` | Deepgram | Continuous | No | Yes | Garbled (echo in stream) |

Default: `auto-continuous-gate`. Best for real phones: `manual-gated-buffer`.

## Half-Duplex Echo Suppression

The critical pattern that makes telephony work:

1. Track `geminiSpeaking` — true when Gemini outputs audio, false 150ms after `turnComplete`
2. While `geminiSpeaking && !deepgram.speaking` → suppress all audio to Gemini AND skip buffer accumulation
3. While `geminiSpeaking && deepgram.speaking` → barge-in detected, allow audio through
4. This keeps the rolling buffer echo-free on turns 1+

Deepgram always receives audio regardless of `geminiSpeaking` — it needs continuous audio for reliable turn detection. Deepgram does NOT false-trigger on echo (confirmed by testing).

## Critical Lessons (MUST follow)

1. **Gemini model**: `gemini-2.5-flash-native-audio-latest` — alias `gemini-2.5-flash` does NOT work for Live API
2. **Model name prefix**: Must include `models/` prefix
3. **API endpoint**: v1beta — `v1alpha` rejects this model name
4. **Tool params**: Empty objects only — string params crash Gemini native audio mode
5. **Manual VAD required for telephony**: `automaticActivityDetection: { disabled: true }` — auto VAD fails on real phone calls after first turn
6. **L16 codec**: `stream_bidirectional_codec: "L16"` — linear PCM, no mulaw lossy encode/decode
7. **L16 is 8kHz LE**: Despite RFC 3551 (BE) and Telnyx docs (16kHz), actual Telnyx L16 is 8kHz little-endian
8. **Deepgram linear16**: encoding=linear16, sample_rate=8000 — receives raw PCM bytes (passthrough from L16)
9. **Rolling buffer**: 15 packets (~300ms) flushed on speech start to capture word onset
10. **Config retry loop**: WS can beat POST /init — 10 retries × 100ms from DO storage
11. **HTTPS webhooks**: ngrok forwards as http — must force https for Telnyx webhook URLs
12. **Inbound speak-first**: Send pre-recorded "Hello" PCM with activityStart/End wrapping to trigger greeting
13. **No proactivity/affectiveDialog**: These fields crash the setup on v1beta
14. **Noise gate threshold 15**: Telephony speech onset can be RMS 30-40, silence is 0-4
15. **Sim results ≠ real phone results**: TTS-to-TTS sim has no echo — auto VAD works on sim but fails on real phones

## Call Flow

### Inbound
1. Telnyx sends `call.initiated` (direction=incoming, state=parked) → Worker answers via REST API
2. Telnyx sends `call.answered` → Worker calls `startStream` with WS URL
3. Telnyx connects WebSocket → DO accepts, connects Deepgram + Gemini
4. Gemini setup complete → send hello audio (activityStart → audio → activityEnd) to trigger greeting
5. Audio flows with half-duplex echo suppression, Deepgram VAD controls activity signals

### Outbound
1. POST /call/outbound → Worker dials via TelnyxService, inits DO with config
2. Telnyx sends `call.answered` → Worker starts streaming
3. Same audio pipeline as inbound (but no hello audio trigger — user speaks first)
4. Streaming latency ~1s from call.answered to first audio

## Development Setup

### Required: `.dev.vars`
```
TELNYX_API_KEY=KEY...
GEMINI_API_KEY=AIza...
DEEPGRAM_API_KEY=...
TELNYX_CONNECTION_ID=...          # Must be Call Control App ID (not SIP Connection)
TELNYX_PHONE_NUMBER=+1XXXXXXXXXX
```

### Starting Development
```bash
# Terminal 1: ngrok (port 8788)
ngrok http 8788 --url=anja-unpetulant-pseudoapologetically.ngrok-free.dev

# Terminal 2: wrangler
npm run dev
```

### Telnyx Setup
- Phone number must be assigned to a **Call Control Application** (NOT a SIP Connection)
- Local dev app ID: `2917216734060480348` (foxvox-app-local)
- Application webhook URL: `https://<ngrok-url>/webhook/call`

### Sim Sweep Testing
- Sim number: +14706258591 (sim-sweep app)
- Run: `./test-sweep.sh manual-gated-buffer` or `./test-sweep.sh all`
- Sim results don't predict real phone performance (no echo on sim)

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/call/outbound` | POST | Initiate outbound call (accepts `pipeline` param) |
| `/webhook/call` | POST | Telnyx call webhooks |
| `/webhook/sim` | POST | Sim sweep test webhooks |
| `/webhook/sms` | POST | Telnyx SMS webhooks |
| `/ws/call-stream/:id` | WS | Telnyx media stream |
| `/call/:id/state` | GET | Call state + transcripts (debug) |
| `/sms/send` | POST | Send SMS |
| `/sms/:number/history` | GET | SMS history |

## Known Issues

- **Turn 0 garbled**: First turn on real phone calls has garbled Gemini transcription — rolling buffer contains call setup noise (not echo). Tolerable since AI responds contextually.
- **Speech onset clipping**: Deepgram StartOfTurn fires 100-500ms after speech onset on telephony audio. Rolling buffer captures 300ms but some words are still clipped. Buffer increase to 500ms may help.
- **No `discardingAudio` pattern yet**: On interruption, in-flight Gemini audio should be dropped until turnComplete (production system does this). Not yet implemented.

## Commit Preferences

- Do NOT include `Co-Authored-By` lines in commits — private repo

## Related Repos

- Production Twilio system: `/Users/usai/Projects/Forward Flow/phone-call-gemini-audio-live`
- Production branch with latest features: `conversation-monitor`
