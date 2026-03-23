import type { ToolDefinition, CallSettings } from '../types';

export interface GeminiLiveConfig {
	apiKey: string;
	model?: string;
	voice?: string;
	systemInstruction: string;
	tools?: ToolDefinition[];
	settings?: CallSettings;
	disableAutoVad?: boolean;
	telephonyVad?: boolean;  // Use LOW sensitivity + telephony-tuned params
}

export interface GeminiCallbacks {
	onAudio?: (audioBase64: string) => void;
	onToolCall?: (id: string, name: string, args: Record<string, any>) => void;
	onTranscript?: (text: string, role: 'user' | 'model') => void;
	onError?: (error: Error) => void;
	onSetupComplete?: () => void;
	onTurnComplete?: () => void;
	onInterrupted?: () => void;
	onToolCallCancellation?: (ids: string[]) => void;
	onUsageMetadata?: (inputTokens: number, outputTokens: number) => void;
}

export interface GeminiServerMessage {
	setupComplete?: { sessionId: string };
	serverContent?: {
		modelTurn?: {
			parts: Array<{
				inlineData?: { mimeType: string; data: string };
				text?: string;
			}>;
		};
		inputTranscription?: { text: string };
		inputTranscript?: string;
		outputTranscription?: { text: string };
		turnComplete?: boolean;
		interrupted?: boolean;
	};
	toolCall?: {
		functionCalls: Array<{
			id: string;
			name: string;
			args: Record<string, any>;
		}>;
	};
	toolCallCancellation?: { ids: string[] };
	usageMetadata?: {
		promptTokenCount?: number;
		candidatesTokenCount?: number;
		totalTokenCount?: number;
	};
}

export const GEMINI_WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
