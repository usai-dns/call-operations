# Call Operations — Telnyx + Gemini Live Voice AI

## Project Overview

Clean boilerplate for a real-time voice AI system bridging Telnyx telephony with Google Gemini Live API. Uses Deepgram for Voice Activity Detection (VAD). Single `CallSession` Durable Object handles all call types (inbound, outbound, future realtor handoff). Behavior driven by config, not subclasses.

Ported from production system (`phone-call-gemini-audio-live`) which uses Twilio. This repo replaces Twilio with Telnyx.

## Technical Stack

- **Runtime**: Cloudflare Workers with Durable Objects
- **Telephony**: Telnyx (PCMU/mulaw 8kHz audio, Call Control API v2, WebSocket streaming)
- **Voice AI**: Google Gemini Live API (native audio, PCM 16kHz in / 24kHz out)
- **VAD**: Deepgram Flux v2 (processes raw mulaw — no conversion artifacts)
- **Language**: TypeScript

## Architecture

```
CallSession (Durable Object)
  │  One class for all call types. Config determines behavior.
  │
  ├── TelnyxService        → REST API (dial, answer, stream, hangup)
  ├── GeminiLiveService    → Gemini Live WS (manual VAD, tool calling)
  ├── DeepgramVADService   → VAD (Flux v2, raw mulaw, turn detection)
  ├── AudioConverter       → mulaw↔PCM conversion
  └── ToolExecutor         → Registry of tools (V1: just end_call)
```

## Directory Structure

```
src/
├── index.ts                    # Worker router
├── types.ts                    # All types in one file
├── config.ts                   # Defaults + resolveConfig()
├── durableObjects/
│   └── CallSession.ts          # THE call orchestrator DO
├── services/
│   ├── GeminiLiveService.ts    # Gemini Live WS client
│   ├── geminiTypes.ts          # Gemini message types
│   ├── DeepgramVADService.ts   # Deepgram Flux VAD
│   ├── AudioConverter.ts       # mulaw↔PCM conversion
│   ├── TelnyxService.ts        # Telnyx REST class wrapper
│   └── ToolExecutor.ts         # Tool registry + dispatch
├── audio/
│   └── helloAudio.ts           # Pre-recorded "Hello" PCM
├── sms/
│   └── SmsSession.ts           # SMS DO
└── utils/
    └── logger.ts               # Structured logging
```

## Audio Pipeline

```
Telnyx WS (mulaw 8kHz base64, PCMU codec)
  │
  ├─→ DeepgramVAD.sendAudio(mulawBase64)     ← raw mulaw, zero conversion
  │     ├─ onSpeechStarted → gemini.signalActivityStart() + flush buffer
  │     ├─ onUtteranceEnd  → gemini.signalActivityEnd()
  │     └─ onEndOfTurn     → (hook for future transcript/monitor)
  │
  └─→ AudioConverter.mulawToGemini() → PCM 16kHz base64
        └─→ [if activityStartSignaled] gemini.sendAudio()
            [else] push to recentAudioBuffer (rolling 15 packets ~300ms)

Gemini (PCM 24kHz base64)
  └─→ AudioConverter.geminiToMulaw() → mulaw 8kHz base64
        └─→ Telnyx WS: {"event":"media","media":{"payload":"..."}}
```

## Critical Lessons (MUST follow)

1. **Gemini model**: `gemini-2.5-flash-native-audio-latest` — alias `gemini-2.5-flash` does NOT work for Live API
2. **Model name prefix**: Must include `models/` prefix (e.g., `models/gemini-2.5-flash-native-audio-latest`)
3. **API endpoint**: v1beta — `v1alpha` rejects this model name
4. **Tool params**: Empty objects only — string params crash Gemini native audio mode (1011 close)
5. **Manual VAD**: `automaticActivityDetection: { disabled: true }` — required
6. **PCMU codec**: `stream_bidirectional_codec: "PCMU"` — can't assume HD voice on receiving end
7. **Raw mulaw to Deepgram**: No conversion → accurate VAD
8. **Rolling buffer**: 15 packets (~300ms) flushed on speech start to capture word onset
9. **Config retry loop**: WS can beat POST /init — 10 retries × 100ms from DO storage
10. **HTTPS webhooks**: ngrok forwards as http — must force https for Telnyx webhook URLs
11. **Inbound speak-first**: Gemini Live manual VAD cannot speak proactively — send pre-recorded "Hello" PCM audio to trigger greeting
12. **No proactivity/affectiveDialog**: These fields crash the setup on v1beta

## Call Flow

### Inbound
1. Telnyx sends `call.initiated` (direction=incoming, state=parked) → Worker answers via REST API
2. Telnyx sends `call.answered` → Worker calls `startStream` with WS URL
3. Telnyx connects WebSocket → DO accepts, connects Deepgram + Gemini
4. Gemini setup complete → send hello audio to trigger greeting
5. Audio flows: Telnyx ↔ AudioConverter ↔ Gemini, Deepgram VAD controls activity signals

### Outbound
1. POST /call/outbound → Worker dials via TelnyxService, inits DO with config
2. Telnyx sends `call.answered` → Worker starts streaming
3. Same audio pipeline as inbound (but no hello audio trigger)

## Telnyx vs Twilio Differences

| Aspect | Twilio | Telnyx |
|--------|--------|--------|
| Webhook format | TwiML + StatusCallback | Call Control API v2 |
| Stream setup | TwiML `<Stream>` | REST `streaming_start` action |
| WS messages | `{event:"media",media:{payload}}` | Same format |
| Audio codec | mulaw 8kHz | PCMU (mulaw 8kHz) — must specify |
| Mark mechanism | `<Say>` marks for end-call timing | None — use simple delay |
| Call answer | Automatic via TwiML | Explicit `answer` command via REST |
| Phone number setup | Twilio Console webhook | Call Control Application webhook |

## Development Setup

### Required: `.dev.vars`
```
TELNYX_API_KEY=KEY...
GEMINI_API_KEY=AIza...
DEEPGRAM_API_KEY=...
TELNYX_CONNECTION_ID=...
TELNYX_PHONE_NUMBER=+1XXXXXXXXXX
TELNYX_MESSAGING_PROFILE_ID=...
```

### Starting Development
```bash
# Terminal 1: ngrok (port 8788 to avoid conflict with production worker on 8787)
ngrok http 8788 --url=anja-unpetulant-pseudoapologetically.ngrok-free.dev

# Terminal 2: wrangler
npm run dev
```

### Telnyx Setup
- Phone number must be assigned to a **Call Control Application** (NOT a SIP Connection)
- Application webhook URL: `https://<ngrok-url>/webhook/call`
- API version: v2 (not TeXML)

**TODO**: Before deploying to Cloudflare Workers production, change the Telnyx Call Control Application webhook URL from ngrok to the Worker's production URL.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/call/outbound` | POST | Initiate outbound call |
| `/webhook/call` | POST | Telnyx call webhooks |
| `/webhook/sms` | POST | Telnyx SMS webhooks |
| `/ws/call-stream/:id` | WS | Telnyx media stream |
| `/call/:id/state` | GET | Call state (debug) |
| `/sms/send` | POST | Send SMS |
| `/sms/:number/history` | GET | SMS history |

## Extensibility Points (all for later)

- Add tools → one file + register in ToolExecutor
- Add reporting → hook into onCallEnd lifecycle
- Add conference/transfer → new tool, same CallSession
- Add voicemail → new service, hooks into audio pipeline
- Add D1 config → resolve config in worker before passing to DO
- Add LLM monitor → new service, hooks into transcript stream

## Commit Preferences

- Do NOT include `Co-Authored-By` lines in commits — private repo

## Related Repos

- Production Twilio system: `/Users/usai/Projects/Forward Flow/phone-call-gemini-audio-live`
- Production branch with latest features: `conversation-monitor`
