// =============================================================================
// Environment
// =============================================================================

export interface Env {
	CALL_SESSION: DurableObjectNamespace;
	SMS_SESSION: DurableObjectNamespace;
	TELNYX_API_KEY: string;
	GEMINI_API_KEY: string;
	DEEPGRAM_API_KEY: string;
	TELNYX_CONNECTION_ID: string;
	TELNYX_PHONE_NUMBER: string;
	TELNYX_MESSAGING_PROFILE_ID: string;
	LOG_LEVEL?: string;
	LOG_FORMAT?: string;
}

// =============================================================================
// Call Config (resolved config passed to DO)
// =============================================================================

export interface CallConfig {
	callId: string;
	direction: 'inbound' | 'outbound';
	to: string;
	from: string;
	prompt: string;
	voice: string;
	model: string;
	telnyxApiKey: string;
	geminiApiKey: string;
	deepgramApiKey: string;
	connectionId: string;
	firstMessage?: string;
	pipeline: PipelineMode;
}

// =============================================================================
// Telnyx Stream Messages (WebSocket)
// =============================================================================

export interface TelnyxStreamMessage {
	event: 'connected' | 'start' | 'media' | 'stop';
	media?: {
		track?: string;
		payload: string;
		chunk?: string;
	};
	start?: {
		stream_id: string;
	};
	stream_id?: string;
}

// =============================================================================
// Tool System
// =============================================================================

export interface ToolDefinition {
	name: string;
	description: string;
	parameters?: {
		type: string;
		properties: Record<string, unknown>;
		required?: string[];
	};
}

export interface ToolResult {
	success: boolean;
	data?: Record<string, unknown>;
	error?: string;
}

export interface ToolContext {
	callId: string;
	callControlId: string | null;
	hangup: () => Promise<void>;
	setPendingEndCall: () => void;
}

// =============================================================================
// Telnyx Webhook Types
// =============================================================================

export interface TelnyxWebhookEvent {
	data: {
		event_type: string;
		id: string;
		occurred_at: string;
		payload: TelnyxCallPayload | TelnyxSmsPayload;
		record_type: string;
	};
	meta: {
		attempt: number;
		delivered_to: string;
	};
}

export interface TelnyxCallPayload {
	call_control_id: string;
	call_leg_id: string;
	call_session_id: string;
	client_state?: string;
	connection_id: string;
	direction: 'incoming' | 'outgoing';
	from: string;
	to: string;
	state: string;
	stream_url?: string;
}

export interface TelnyxSmsPayload {
	id: string;
	direction: 'inbound' | 'outbound';
	from: { phone_number: string; carrier?: string; line_type?: string };
	to: { phone_number: string }[] | { phone_number: string };
	text: string;
	type: 'SMS' | 'MMS';
	messaging_profile_id: string;
	media?: { url: string; content_type: string }[];
}

// =============================================================================
// API Request Types
// =============================================================================

export interface OutboundCallRequest {
	to: string;
	from?: string;
	prompt?: string;
	voice?: string;
	model?: string;
	firstMessage?: string;
	pipeline?: PipelineMode;
}

export interface OutboundSmsRequest {
	to: string;
	text: string;
	from?: string;
	mediaUrls?: string[];
}

// =============================================================================
// Gemini Types (used by GeminiLiveService)
// =============================================================================

export interface CallSettings {
	temperature?: number;
	thinkingBudget?: number;
}

// =============================================================================
// Pipeline Modes
// =============================================================================

export type PipelineMode =
	| 'auto-continuous-gate'      // Gemini auto VAD, continuous audio, noise gate
	| 'auto-continuous-raw'       // Gemini auto VAD, continuous audio, no gate
	| 'manual-gated-buffer'       // Deepgram manual VAD, gated audio, 300ms buffer flush
	| 'manual-gated-nobuffer'     // Deepgram manual VAD, gated audio, no buffer flush
	| 'manual-continuous'         // Deepgram manual VAD, continuous audio, no gate
	| 'manual-continuous-gate';   // Deepgram manual VAD, continuous audio, noise gate

export interface PipelineFlags {
	useManualVad: boolean;
	gateAudio: boolean;
	flushBuffer: boolean;
	noiseGate: boolean;
}

// =============================================================================
// Transcript Comparison
// =============================================================================

export interface TranscriptEntry {
	source: 'gemini' | 'deepgram';
	role: 'user' | 'model';
	text: string;
	timestamp: number;
}

// =============================================================================
// Internal Call State
// =============================================================================

export interface SmsConversationState {
	phoneNumber: string;
	messages: { role: 'user' | 'assistant'; text: string; timestamp: number }[];
	createdAt: number;
	lastMessageAt: number;
}
