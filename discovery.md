# Discovery Log — Voice AI Audio Pipeline

Lessons learned building a Telnyx + Gemini Live telephony voice AI system, ported from a working Twilio production system. Documents the experiments, failures, and breakthroughs that led to the current architecture.

## The Core Challenge

Bridge telephony audio (8kHz, noisy, echoing) to Gemini Live API (expects clean 16kHz PCM) with fast turn detection and clean transcription. Sounds simple — took many iterations to get right.

## Chapter 1: Mulaw Pipeline (Starting Point)

Ported directly from the production Twilio system:
- Telnyx sends PCMU (mulaw 8kHz)
- Decode mulaw → upsample 8kHz→16kHz → send to Gemini
- Gemini output → downsample 24kHz→8kHz → encode mulaw → send to Telnyx
- Deepgram receives raw mulaw for VAD

**Initial problem**: Gemini couldn't hear the caller at all. Said "sorry, I'm having trouble hearing you" repeatedly.

**Root cause**: Missing 200ms flush delay. When Deepgram detected EndOfTurn, we signaled `activityEnd` to Gemini immediately. But audio packets were still in-flight from Telnyx. Gemini received activityEnd before the last words arrived, so it processed truncated audio.

**Fix**: 200ms delay between Deepgram EndOfTurn and signaling `activityEnd` to Gemini. This let in-flight packets arrive before closing the activity window. Matched the production system's behavior.

**Result**: Calls worked. But first 1-2 turns had garbled Gemini transcription — Gemini heard Arabic, Thai, Vietnamese text instead of English.

## Chapter 2: The Garbled Transcription Mystery

Deepgram transcribed perfectly: "How are you today?" But Gemini heard: "بتاع" (Arabic).

Both received the same source audio. The only difference: Deepgram got raw mulaw, Gemini got converted PCM. We assumed the conversion was wrong.

**Investigation**: Compared AudioConverter code line-by-line with production. Identical. Mulaw decode tables identical. Upsampling identical. LE encoding identical.

**Key clue**: The pre-recorded "Hello" audio (pure PCM, no conversion) was ALSO transcribed as gibberish by Gemini — but Gemini responded with a correct greeting anyway. This meant the conversion wasn't the problem.

**Real root cause**: The rolling buffer. When Deepgram detected speech start, we flushed 300ms of pre-speech audio to Gemini. On the first turns, this buffer contained:
- Call setup noise (turn 0)
- Echo of Gemini's own response playing through the caller's phone speaker (turns 1-2)

This noise-contaminated buffer was injected into Gemini's activity window along with the real speech. Gemini tried to transcribe the noise, producing foreign-language gibberish.

**Evidence**: After 2-3 turns, when the phone's acoustic echo cancellation (AEC) had converged, the buffer was clean and transcription was perfect.

## Chapter 3: L16 PCM Codec Switch

**Hypothesis**: Maybe mulaw's lossy encode/decode was adding artifacts. Switch to L16 (linear PCM) to eliminate the lossy step.

**Findings during implementation**:
- Telnyx docs suggest L16 is 16kHz. It's actually **8kHz** (telephony rate). Discovered when Gemini's voice played at half speed (deep, slow-motion).
- RFC 3551 says L16 is big-endian. Telnyx sends **little-endian**. Discovered when byte-swapping produced static.
- Still need upsample 8kHz→16kHz for Gemini and downsample 24kHz→8kHz for Telnyx. But no mulaw encode/decode.

**Result**: Cleaner audio path, but the garbled transcription persisted. Confirmed the issue was never the codec — it was always the buffer echo.

## Chapter 4: Auto VAD — The False Hope

**Hypothesis**: If we send audio continuously (no gating, no buffer flush) and let Gemini's built-in auto VAD handle turn detection, the buffer problem goes away entirely.

**Result on sim (TTS-to-TTS)**: Perfect. Clean transcription on all turns. `auto-continuous-raw` was the clear winner.

**Result on real phones**: Complete failure. Gemini responded to the first turn then stopped detecting speech entirely. The telephony noise floor (constant low-level line hiss) prevents Gemini from ever detecting "silence", so its auto VAD never registers turn boundaries.

**Tuning attempts**:
- `START_SENSITIVITY_HIGH` + `END_SENSITIVITY_HIGH`: Worse — 5-7 second latency per turn
- `START_SENSITIVITY_LOW` + `END_SENSITIVITY_LOW`: Note — "LOW" means "triggers more easily" (counterintuitive naming). Worked for one turn on real phones, then stopped.
- Noise gate (RMS threshold to replace quiet audio with true zeros): Helped auto VAD detect the first turn faster (~4s vs ~7s), but subsequent turns still failed.

**Key learning**: Sim results don't predict real phone performance. The sim is TTS-to-TTS with no echo, no telephony noise floor, clean digital audio. It's useful for validating turn detection logic but not for tuning VAD sensitivity.

**Key learning**: Gemini's auto VAD is designed for clean microphone input (laptop/phone mic), not telephony audio. Manual VAD (Deepgram signals) is required for telephony.

## Chapter 5: The Hybrid Approaches

Tried combining continuous audio with manual VAD signals:

**Manual VAD + continuous audio**: Garbled on ALL turns (not just first 1-2). Sending continuous audio means Gemini's activity window includes the echo from its own response. Even with Deepgram signaling precise turn boundaries, the continuous stream is contaminated.

**Manual VAD + continuous audio + noise gate**: Same result. The noise gate replaces silence with zeros but doesn't remove echo (echo is above the noise gate threshold since it's actual speech audio).

**Conclusion**: Audio must be gated (only sent during activityStart→activityEnd) to avoid echo contamination. Continuous audio + manual VAD is fundamentally incompatible because the continuous stream carries echo.

## Chapter 6: Half-Duplex Echo Suppression — The Breakthrough

Discovered by analyzing the production Twilio system's `AudioRouter` pattern.

**The insight**: The production system never sends user audio to Gemini while the AI is speaking. Not because of explicit echo cancellation — just simple state gating.

When Gemini outputs audio → set `geminiSpeaking = true`. While `geminiSpeaking`:
- Don't send audio to Gemini
- Don't accumulate the rolling buffer
- Exception: if Deepgram detects speech (barge-in), allow audio through

When `turnComplete` fires → wait 150ms (tail suppression for in-flight echo) → set `geminiSpeaking = false`. Resume normal audio flow and buffer accumulation.

**Why this works**: The rolling buffer only accumulates audio from when Gemini is NOT speaking. By the time the user speaks, the buffer contains clean post-silence audio — no echo of the AI's response. When Deepgram fires StartOfTurn and we flush the buffer, Gemini receives clean word-onset audio.

**Result**: Multi-turn conversation working. Turns 1+ have clean transcription, fast response (~1-2s), and interruptions work. Turn 0 remains garbled due to call setup noise (not echo).

**Why Deepgram doesn't false-trigger on echo**: Confirmed by checking logs across all calls — Deepgram never fired StartOfTurn during Gemini speech. Deepgram Flux processes the echo audio but doesn't classify it as a turn start. This makes it safe to keep Deepgram receiving audio during AI speech for barge-in detection.

## Chapter 7: Sweep Testing Infrastructure

Built automated testing: a Telnyx sim number (+14706258591) that answers and plays scripted TTS, plus a parameterized pipeline system (7 modes switchable via API body).

**Sweep results** (sim — TTS-to-TTS, no echo):

| Mode | Turn 1 Quality | Turn 2 Quality | Speed |
|------|---------------|----------------|-------|
| auto-continuous-raw | Perfect | Perfect | 0.8s |
| manual-gated-nobuffer | Good (clipped "Hello") | Good | 0.9s |
| manual-gated-buffer | Clipped start | Clipped | 1.2s |
| auto-continuous-gate | Merged turns | Poor | 1.1s |
| manual-continuous | Garbled | Garbled | 1.5s |
| manual-continuous-gate | Good | Clipped | 1.3s |

**Real phone results** (with human caller):

| Mode | Result |
|------|--------|
| auto-continuous-raw | No response (auto VAD fails) |
| auto-tuned-telephony | One response then stops |
| manual-gated-buffer + echo suppression | **Works** — turn 0 garbled, turns 1+ clean |
| manual-gated-nobuffer | First hello lost, turn 1 garbled |
| manual-continuous | Garbled all turns |

**The lesson**: Always test on real phones. Sim tests validate logic, not audio quality.

## Remaining Open Questions

### Speech Onset Clipping
Deepgram StartOfTurn fires 100-500ms after speech onset on telephony audio. The 300ms (15 packet) rolling buffer doesn't fully cover this gap. Clipping pattern: "Can you tell me about cats" → Gemini hears "tell me about cats." Increasing to 500ms (25 packets) may help. The buffer is echo-free thanks to half-duplex suppression so a larger buffer is safe on turns 1+.

### Interruption Management
Current barge-in works (Deepgram detects speech during AI playback → audio passes through → Gemini gets interrupted). Missing from production system: `discardingAudio` flag that drops all in-flight Gemini audio packets between interruption and turnComplete. Also missing: Telnyx equivalent of Twilio's `clear` WebSocket command to immediately stop audio playback.

### Turn 0 Quality
First turn on real calls always has garbled transcription because the rolling buffer contains call setup noise. The production system has the same issue. Potential approaches: skip buffer flush on turn 0, use a smaller buffer for turn 0, or accept it as a known limitation.

### Deepgram Flux Capabilities
- No tuning parameters for StartOfTurn sensitivity (only end-of-turn thresholds exist)
- Zero echo awareness — processes whatever audio you send, including echo
- Does NOT false-trigger StartOfTurn on echo in practice (confirmed)
- EagerEndOfTurn could be used for speculative early turn processing (not implemented)
- Deepgram's managed Voice Agent API has echo cancellation, but standalone Flux streaming does not

## Architecture Principles (Earned Through Failure)

1. **Telephony audio is fundamentally different from digital audio.** Clean-room solutions that work on sim/TTS/microphone input will fail on real phone calls.

2. **Half-duplex is the simplest effective echo management.** Don't send audio while the AI speaks. No adaptive filters, no spectral subtraction, no echo cancellation algorithms needed.

3. **Deepgram for turn detection, Gemini for processing.** Deepgram Flux is fast and reliable for detecting speech start/end on telephony audio. Gemini's auto VAD is not. Let each system do what it's good at.

4. **The rolling buffer exists because Deepgram is slower than real-time.** Speech starts before Deepgram detects it. The buffer captures the onset. Half-duplex suppression keeps it clean.

5. **Test on real phones early and often.** Sim tests validate logic. Phone tests validate audio. They measure different things.
