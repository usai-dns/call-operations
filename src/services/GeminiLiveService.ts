import { logger } from '../utils/logger';
import { DEFAULT_GEMINI_MODEL, DEFAULT_GEMINI_VOICE, DEFAULT_TEMPERATURE, DEFAULT_THINKING_BUDGET } from '../config';
import type { GeminiLiveConfig, GeminiCallbacks, GeminiServerMessage } from './geminiTypes';
import { GEMINI_WS_URL } from './geminiTypes';

export class GeminiLiveService {
	private log = logger.child('GeminiLive');
	private ws: WebSocket | null = null;
	private config: GeminiLiveConfig;
	private callbacks: GeminiCallbacks = {};
	private isConnected = false;
	private sessionId: string | null = null;
	private connectResolve: (() => void) | null = null;
	private connectReject: ((error: Error) => void) | null = null;

	constructor(config: GeminiLiveConfig) {
		this.config = config;
	}

	async connect(callbacks: GeminiCallbacks): Promise<void> {
		this.callbacks = callbacks;
		const url = `${GEMINI_WS_URL}?key=${this.config.apiKey}`;

		return new Promise((resolve, reject) => {
			this.connectResolve = resolve;
			this.connectReject = reject;

			this.ws = new WebSocket(url);

			this.ws.addEventListener('open', () => {
				this.log.info('WebSocket connected');
				this.sendSetup();
			});

			this.ws.addEventListener('message', (event) => {
				this.handleMessage(event.data);
			});

			this.ws.addEventListener('error', (event) => {
				this.log.error('WebSocket error', { event: String(event) });
				const error = new Error('WebSocket connection error');
				this.callbacks.onError?.(error);
				if (!this.isConnected && this.connectReject) {
					this.connectReject(error);
					this.connectReject = null;
					this.connectResolve = null;
				}
			});

			this.ws.addEventListener('close', (event) => {
				this.log.info('WebSocket closed', { code: event.code, reason: event.reason });
				this.isConnected = false;
				this.ws = null;
			});
		});
	}

	private sendSetup(): void {
		const rawModel = this.config.model || DEFAULT_GEMINI_MODEL;
		const model = rawModel.startsWith('models/') ? rawModel : `models/${rawModel}`;
		const voice = this.config.voice || DEFAULT_GEMINI_VOICE;

		const functionDeclarations = this.config.tools?.map(tool => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters || { type: 'object', properties: {} }
		})) || [];

		const setupMessage = {
			setup: {
				model,
				generationConfig: {
					responseModalities: ['AUDIO'],
					speechConfig: {
						voiceConfig: {
							prebuiltVoiceConfig: { voiceName: voice }
						}
					},
					temperature: this.config.settings?.temperature ?? DEFAULT_TEMPERATURE,
					thinkingConfig: { thinkingBudget: DEFAULT_THINKING_BUDGET },
				},
				systemInstruction: {
					parts: [{ text: this.config.systemInstruction }]
				},
				tools: functionDeclarations.length > 0
					? [{ functionDeclarations }]
					: undefined,
				inputAudioTranscription: {},
				outputAudioTranscription: {},
				...(this.config.disableAutoVad ? {
					realtimeInputConfig: {
						automaticActivityDetection: { disabled: true }
					}
				} : this.config.telephonyVad ? {
					realtimeInputConfig: {
						automaticActivityDetection: {
							disabled: false,
							startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
							endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
							prefixPaddingMs: 200,
							silenceDurationMs: 500,
						}
					}
				} : {})
			}
		};

		this.log.debug('Sending setup message');
		this.ws?.send(JSON.stringify(setupMessage));
	}

	private handleMessage(data: string | ArrayBuffer): void {
		try {
			const message: GeminiServerMessage = JSON.parse(
				typeof data === 'string' ? data : new TextDecoder().decode(data)
			);

			if (message.setupComplete) {
				this.sessionId = message.setupComplete.sessionId || 'connected';
				this.isConnected = true;
				this.log.info('Setup complete', { sessionId: this.sessionId });

				if (this.connectResolve) {
					this.connectResolve();
					this.connectResolve = null;
					this.connectReject = null;
				}

				this.callbacks.onSetupComplete?.();
				return;
			}

			if (message.serverContent) {
				const content = message.serverContent;

				if (content.modelTurn?.parts) {
					for (const part of content.modelTurn.parts) {
						if (part.inlineData?.mimeType?.startsWith('audio/')) {
							this.callbacks.onAudio?.(part.inlineData.data);
						}
						if (part.text) {
							this.callbacks.onTranscript?.(part.text, 'model');
						}
					}
				}

				if (content.inputTranscript) {
					this.callbacks.onTranscript?.(content.inputTranscript, 'user');
				}
				if (content.inputTranscription?.text) {
					this.callbacks.onTranscript?.(content.inputTranscription.text, 'user');
				}
				if (content.outputTranscription?.text) {
					this.callbacks.onTranscript?.(content.outputTranscription.text, 'model');
				}

				// Process interrupted BEFORE turnComplete (ordering matters)
				if (content.interrupted) {
					this.log.info('Response interrupted by user');
					this.callbacks.onInterrupted?.();
				}

				if (content.turnComplete) {
					this.log.debug('Turn complete');
					this.callbacks.onTurnComplete?.();
				}

				return;
			}

			if (message.toolCall) {
				this.log.info('Tool call received', { toolCall: message.toolCall });
				for (const fc of message.toolCall.functionCalls) {
					this.callbacks.onToolCall?.(fc.id, fc.name, fc.args || {});
				}
				return;
			}

			if (message.toolCallCancellation) {
				this.log.info('Tool call cancelled', { ids: message.toolCallCancellation.ids.join(', ') });
				this.callbacks.onToolCallCancellation?.(message.toolCallCancellation.ids);
				return;
			}

			if (message.usageMetadata) {
				this.callbacks.onUsageMetadata?.(
					message.usageMetadata.promptTokenCount || 0,
					message.usageMetadata.candidatesTokenCount || 0,
				);
				return;
			}

		} catch (error) {
			this.log.error('Failed to parse message', { error: String(error) });
		}
	}

	sendAudio(audioBase64: string): void {
		if (!this.ws || !this.isConnected) return;

		this.ws.send(JSON.stringify({
			realtimeInput: {
				audio: {
					mimeType: 'audio/pcm;rate=16000',
					data: audioBase64
				}
			}
		}));
	}

	sendText(text: string): void {
		if (!this.ws || !this.isConnected) return;

		this.ws.send(JSON.stringify({
			clientContent: {
				turns: [{ role: 'user', parts: [{ text }] }],
				turnComplete: true
			}
		}));
	}

	sendSystemNotification(notification: string): void {
		if (!this.ws || !this.isConnected) return;

		this.ws.send(JSON.stringify({
			clientContent: {
				turns: [{ role: 'user', parts: [{ text: `[SYSTEM NOTIFICATION] ${notification}` }] }],
				turnComplete: false
			}
		}));
	}

	sendToolResponse(id: string, name: string, response: Record<string, any>): void {
		if (!this.ws || !this.isConnected) return;

		this.ws.send(JSON.stringify({
			toolResponse: {
				functionResponses: [{ id, name, response }]
			}
		}));
	}

	signalActivityStart(): void {
		if (!this.ws || !this.isConnected) return;
		this.ws.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
	}

	signalActivityEnd(): void {
		if (!this.ws || !this.isConnected) return;
		this.ws.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
	}

	get connected(): boolean {
		return this.isConnected;
	}

	close(): void {
		if (this.ws) {
			this.log.info('Closing connection');
			this.ws.close();
			this.ws = null;
			this.isConnected = false;
		}
	}
}
