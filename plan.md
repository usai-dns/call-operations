# Development Plan — Phone Worker Sales Assistant

## Vision

Phone worker that qualifies leads via outbound/inbound calls, pages a realtor, bridges the realtor into the conversation, and executes a warm handoff. Built on Telnyx + Gemini Live + Deepgram Flux on Cloudflare Workers.

The broader system (text layer, video layer, CRM assistant, multi-vertical) is acknowledged but NOT scoped here. This plan covers only the phone worker through conference handoff.

## Current State

### Solved
- Telnyx ↔ Gemini audio bridge (L16 PCM, upsample/downsample, noise gate)
- Deepgram Flux VAD (manual turn coordination, transcript comparison)
- Half-duplex echo suppression (`geminiSpeaking` flag + barge-in bypass)
- Basic call flow (inbound with hello trigger, outbound)
- Tool execution pattern (registry, dispatch, end_call deferred to turnComplete)
- Transcript collection (Deepgram + Gemini side-by-side)
- Sim sweep testing infrastructure

### Partially Solved
- **Interruption handling** — Gemini sends `interrupted`, echo suppression allows barge-in, but no `discardingAudio` to drop stale packets, no Telnyx playback clear
- **Speech onset capture** — 300ms buffer clips first word, needs 500ms
- **Turn 0 quality** — garbled from call setup noise, tolerable

### Missing
- Call state machine (phases, audio routing rules, tool permissions per phase)
- Dual-call bridge (second DO for realtor call)
- Realtor listening mode (audio fork from lead stream)
- Warm handoff injection (context injection, introduction, conference merge)
- Telnyx conference API integration
- Qualifying tools (call_realtor, confirm_ready, add_to_conference)
- Script/prompt system (dynamic prompt with phases and session variables)
- Per-number config (D1/KV for prompt, realtor assignment, voice)
- Default pipeline fix (currently defaults to auto-continuous-gate which fails on real phones)

---

## Branch Plan

### Phase 1 — Stabilize (no dependencies, parallel)

#### `feat/interruption-handling` — Small
**What**: Add `discardingAudio` flag to drop in-flight Gemini audio on interruption. Increase rolling buffer from 15 to 25 packets (500ms). Research Telnyx playback clear equivalent.

**Changes**:
- Add `discardingAudio: boolean` to CallSession
- Set on `onInterrupted`, clear on `onTurnComplete`
- Early return in `handleGeminiAudio` if `discardingAudio`
- Increase `RECENT_AUDIO_BUFFER_SIZE` from 15 to 25
- Research/implement Telnyx clear (may be silence burst or stream restart)

**Verify**:
- Outbound call → let AI speak → interrupt mid-sentence → AI stops within ~200ms, no trailing audio
- AI responds correctly to the interruption
- Sim sweep regression — existing modes still work
- Test with short ("stop") and long ("actually I wanted to ask about something else") interruptions

**Depends on**: nothing

#### `feat/default-pipeline-fix` — Small
**What**: Fix default pipeline, clean up logging, minor issues.

**Changes**:
- `DEFAULT_PIPELINE` → `manual-gated-buffer`
- Move RMS `console.log` to structured logger at debug level
- Add `auto-tuned-telephony` to `test-sweep.sh` ALL_MODES
- Remove unused `firstMessage` field from CallConfig or wire it up
- Add `isSpeaking` back to `/state` response (removed during refactor)

**Verify**:
- Inbound call works without passing pipeline param
- Logs are clean at info level (no RMS spam)
- `./test-sweep.sh all` includes all 7 modes

**Depends on**: nothing

---

### Phase 2 — State Machine (blocks all handoff work)

#### `feat/call-state-machine` — Medium
**What**: Introduce call phases that control audio routing and tool permissions. Port the concept from production's `CallStateMachine`.

**Phases**:
```
CONNECTING        → services initializing
GREETING          → inbound: hello audio sent, awaiting response
                    outbound: awaiting user's first speech
CONVERSING        → qualifying conversation with lead
PAGING_REALTOR    → realtor call initiated, awaiting confirmation
HANDING_OFF       → realtor listening, AI introducing
IN_CONFERENCE     → both parties in conference, AI exits
ENDING            → hangup sequence
```

**Changes**:
- New `CallPhase` type and `CallStateMachine` class
- State machine defines per-phase: allowed tools, audio routes, transition triggers
- CallSession consults state machine before routing audio or executing tools
- Phase transitions logged with timestamps
- `/state` endpoint includes current phase

**Verify**:
- Existing single-call flow works: CONNECTING → GREETING → CONVERSING → ENDING
- Invalid tool calls rejected (e.g., `add_to_conference` in CONVERSING)
- Phase transitions logged correctly
- No regression on audio quality

**Depends on**: interruption-handling (clean interruption needed before adding state complexity)

---

### Phase 3 — Dual-Call Bridge (sequential, each blocks the next)

#### `feat/realtor-call-do` — Large
**What**: New Durable Object class `RealtorCallSession`. Handles the outbound call to the realtor. Has its own Gemini session with a short "confirm availability" script. Exposes `confirm_ready` tool.

**Changes**:
- New DO class `RealtorCallSession` in `src/durableObjects/`
- New migration tag in `wrangler.toml` for the new class
- `call_realtor` tool registered in ToolExecutor — dials realtor, creates RealtorCallSession DO, transitions lead to PAGING_REALTOR
- RealtorCallSession connects own Gemini + Deepgram, runs availability script
- On `confirm_ready`: signals lead's CallSession (via fetch to lead DO)
- New webhook path `/webhook/realtor` for realtor call events

**Verify**:
- `call_realtor` tool dials a test number
- RealtorCallSession connects, plays script, accepts `confirm_ready`
- Signal reaches lead's CallSession (verified via `/state` endpoint showing `realtorReady`)
- Lead call continues normally during paging

**Depends on**: call-state-machine

#### `feat/audio-fork-bridge` — Medium
**What**: Lead's CallSession accepts a second WebSocket connection from the realtor's redirected stream. Forks lead's Telnyx audio to the realtor's WebSocket. Controlled by state machine (HANDING_OFF phase only).

**Changes**:
- New `/ws/realtor-stream/:id` endpoint in worker router
- CallSession accepts second WebSocket, stores as `realtorWs`
- In `handleAudio`, fork audio to `realtorWs` when in HANDING_OFF phase
- RealtorCallSession redirects realtor's Telnyx stream to lead's realtor-stream endpoint on `confirm_ready`
- State transition: PAGING_REALTOR → HANDING_OFF when realtor WS connects

**Verify**:
- Realtor hears lead's conversation (audio fork working)
- Lead does NOT hear the realtor yet
- Audio quality acceptable on both sides
- Lead's Gemini conversation unaffected by the fork

**Depends on**: realtor-call-do

#### `feat/warm-handoff` — Large
**What**: Full handoff flow. When `realtorReady` is set, inject context into Gemini to trigger introduction. AI introduces realtor, then calls `add_to_conference` tool. Conference merge via Telnyx Call Control.

**Changes**:
- Handoff injection: on HANDING_OFF entry, send system notification to Gemini with handoff instructions
- `add_to_conference` tool: triggers Telnyx conference merge
- Conference setup: both calls joined into Telnyx conference room
- State transition: HANDING_OFF → IN_CONFERENCE after conference merge
- AI cleanup: close Gemini + Deepgram after conference merge (AI exits)

**Verify**:
- Full flow: lead call → qualifying → `call_realtor` → realtor confirms → AI introduces → conference
- Both parties hear each other in conference
- AI exits cleanly after conference merge
- Lead and realtor can continue conversation without AI

**Depends on**: audio-fork-bridge

---

### Phase 4 — Qualifying Intelligence (parallel with Phase 3)

#### `feat/qualifying-script` — Medium
**What**: Dynamic prompt system with phases, qualifying questions, session variables, and handoff instructions embedded.

**Changes**:
- Script template system (TypeScript template strings with variable injection)
- Session variables tracked in CallSession (lead name, interest signals, qualifying answers)
- Phase-aware prompt sections (different instructions per call phase)
- Handoff section with introduction template
- System notification injection at phase transitions

**Verify**:
- AI follows qualifying script appropriately
- Session variables extracted from conversation
- Phase-appropriate behavior (doesn't try to hand off before qualifying)
- Handoff introduction uses extracted session variables

**Depends on**: call-state-machine (needs phase awareness)

---

### Experiments (may not merge)

#### `experiment/telnyx-conference-api` — Small
**What**: Spike on Telnyx Call Control conference endpoints. Test merging two active calls.

**Questions to answer**:
- Can we merge two active streaming calls into a conference?
- What happens to the WebSocket streams after conference merge?
- Does the DO lose audio control?
- Is there a `conference` action in Call Control v2?
- Latency of conference merge?

**Depends on**: nothing (pure research, do early)

#### `experiment/buffer-size-tuning` — Small
**What**: Test buffer sizes 15/20/25/30/40 against real phone calls. Measure speech onset clipping.

**Depends on**: nothing

---

## Dependency Graph

```
feat/interruption-handling ─────┐
feat/default-pipeline-fix ──────┤
                                ├──→ feat/call-state-machine
experiment/telnyx-conference-api│          │
                                │          ├──→ feat/realtor-call-do
                                │          │          │
feat/qualifying-script ─────────┘          │          ├──→ feat/audio-fork-bridge
  (parallel, needs state machine)          │                    │
                                           │                    ├──→ feat/warm-handoff
                                           │
experiment/buffer-size-tuning (anytime)
```

## Execution Order

1. `feat/interruption-handling` + `feat/default-pipeline-fix` + `experiment/telnyx-conference-api` (parallel)
2. `feat/call-state-machine`
3. `feat/realtor-call-do` + `feat/qualifying-script` (parallel)
4. `feat/audio-fork-bridge`
5. `feat/warm-handoff`

---

## Twilio Migration Notes

Findings from this Telnyx implementation that affect the production Twilio system:

| Finding | Impact on Twilio System |
|---------|------------------------|
| Half-duplex echo suppression works with simple flag | Production's AudioRouter uses same pattern — validated |
| Deepgram does NOT false-trigger on echo | Simplifies AudioRouter — no need for echo-specific Deepgram gating |
| Auto VAD fails on telephony | Production already uses manual VAD — confirmed correct |
| 200ms EndOfTurn delay needed for Telnyx | Production doesn't have this — may be Telnyx-specific timing |
| L16 eliminates mulaw lossy step | Production could switch if Twilio supports L16 streaming |
| Noise gate (RMS 15) needed for L16 | Not needed for mulaw — different noise characteristics |
| Sim tests don't predict real phone results | Test infrastructure is useful for logic, not audio quality |
| Telnyx lacks `clear` WebSocket command | Production relies on this — Telnyx needs a workaround |
| Telnyx lacks mark mechanism | Production uses Twilio marks for end-call timing — Telnyx uses delays |
| Buffer echo is the #1 audio quality issue | Production has same pattern — half-duplex suppression is the fix |
