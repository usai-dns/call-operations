import type { CallConfig, Env, OutboundCallRequest } from './types';

// =============================================================================
// Service-Level Defaults
// =============================================================================

/** CRITICAL: Must use full model name, NOT alias — alias breaks Live API */
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash-native-audio-latest';
export const DEFAULT_GEMINI_VOICE = 'Kore';
export const DEFAULT_TEMPERATURE = 1.0;
export const DEFAULT_THINKING_BUDGET = 0; // Disabled for latency

export const AUDIO_SAMPLE_RATES = {
	telnyx: 8000,     // L16 codec (telephony rate)
	geminiIn: 16000,
	geminiOut: 24000,
	deepgram: 8000,   // linear16
} as const;

const DEFAULT_PROMPT = `You are a helpful AI phone assistant. You are answering a live phone call.
Be conversational, friendly, and concise. Keep responses brief since this is a voice conversation.
If the caller asks who you are, say you are an AI assistant.`;

// =============================================================================
// Config Resolution
// =============================================================================

export function resolveOutboundConfig(body: OutboundCallRequest, env: Env, callId: string): CallConfig {
	return {
		callId,
		direction: 'outbound',
		to: body.to,
		from: body.from ?? env.TELNYX_PHONE_NUMBER,
		prompt: body.prompt ?? DEFAULT_PROMPT,
		voice: body.voice ?? DEFAULT_GEMINI_VOICE,
		model: body.model ?? DEFAULT_GEMINI_MODEL,
		telnyxApiKey: env.TELNYX_API_KEY,
		geminiApiKey: env.GEMINI_API_KEY,
		deepgramApiKey: env.DEEPGRAM_API_KEY,
		connectionId: env.TELNYX_CONNECTION_ID,
		firstMessage: body.firstMessage,
	};
}

export function resolveInboundConfig(
	payload: { from: string; to: string },
	env: Env,
	callId: string
): CallConfig {
	return {
		callId,
		direction: 'inbound',
		to: payload.to,
		from: payload.from,
		prompt: DEFAULT_PROMPT,
		voice: DEFAULT_GEMINI_VOICE,
		model: DEFAULT_GEMINI_MODEL,
		telnyxApiKey: env.TELNYX_API_KEY,
		geminiApiKey: env.GEMINI_API_KEY,
		deepgramApiKey: env.DEEPGRAM_API_KEY,
		connectionId: env.TELNYX_CONNECTION_ID,
		firstMessage: 'Hello',
	};
}
