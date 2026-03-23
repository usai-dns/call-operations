import type { Env, CallConfig, TelnyxStreamMessage, TranscriptEntry } from '../types';
import { GeminiLiveService } from '../services/GeminiLiveService';
import { DeepgramVADService } from '../services/DeepgramVADService';
import { AudioConverter } from '../services/AudioConverter';
import { TelnyxService } from '../services/TelnyxService';
import { ToolExecutor } from '../services/ToolExecutor';
import { HELLO_AUDIO_PCM_BASE64 } from '../audio/helloAudio';
import { logger, Logger, runWithContext } from '../utils/logger';

const CONFIG_RETRY_ATTEMPTS = 10;
const CONFIG_RETRY_DELAY_MS = 100;
const END_CALL_DELAY_MS = 500;

export class CallSession implements DurableObject {
	private doState: DurableObjectState;
	private env: Env;

	// Services
	private gemini: GeminiLiveService | null = null;
	private deepgram: DeepgramVADService | null = null;
	private audio: AudioConverter = new AudioConverter();
	private telnyx: TelnyxService | null = null;
	private tools: ToolExecutor = ToolExecutor.withDefaults();

	// State
	private config: CallConfig | null = null;
	private callControlId: string | null = null;
	private streamId: string | null = null;
	private telnyxWs: WebSocket | null = null;
	private audioBuffer: string[] = [];
	private pendingEndCall = false;
	private callStartTime = 0;
	private geminiConnecting = false;
	private transcripts: TranscriptEntry[] = [];
	private log: Logger;

	constructor(state: DurableObjectState, env: Env) {
		this.doState = state;
		this.env = env;
		this.log = Logger.fromEnv(env as unknown as Record<string, unknown>, 'CallSession');
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
			return this.handleWebSocket();
		}

		if (url.pathname === '/init' && request.method === 'POST') {
			this.config = await request.json() as CallConfig;
			await this.doState.storage.put('config', this.config);
			this.log.info('Config initialized', { callId: this.config.callId, direction: this.config.direction });
			return Response.json({ ok: true });
		}

		if (url.pathname === '/state') {
			const cfg = this.config ?? await this.doState.storage.get<CallConfig>('config');
			const txs = this.transcripts.length > 0
				? this.transcripts
				: (await this.doState.storage.get<TranscriptEntry[]>('transcripts')) ?? [];
			return Response.json({
				callId: cfg?.callId,
				direction: cfg?.direction,
				callControlId: this.callControlId,
				geminiConnected: this.gemini?.connected ?? false,
				deepgramConnected: this.deepgram?.connected ?? false,
				pendingEndCall: this.pendingEndCall,
				transcripts: txs,
			});
		}

		if (url.pathname === '/event' && request.method === 'POST') {
			return this.handleEvent(request);
		}

		return Response.json({ error: 'not found' }, { status: 404 });
	}

	// =========================================================================
	// WebSocket (Telnyx media stream)
	// =========================================================================

	private handleWebSocket(): Response {
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);

		this.doState.acceptWebSocket(server);
		this.telnyxWs = server;
		this.callStartTime = Date.now();

		this.log.info('Telnyx WebSocket connected');

		// Start connecting services — config may not be available yet
		this.connectServices();

		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (typeof message !== 'string') return;

		try {
			const data = JSON.parse(message) as TelnyxStreamMessage;

			switch (data.event) {
				case 'start':
					this.streamId = data.stream_id ?? data.start?.stream_id ?? null;
					this.log.info('Telnyx stream started', { streamId: this.streamId });
					break;

				case 'media':
					if (data.media?.payload) {
						this.handleAudio(data.media.payload);
					}
					break;

				case 'stop':
					this.log.info('Telnyx stream stopped');
					this.cleanup();
					break;
			}
		} catch {
			// Non-JSON message, ignore
		}
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
		this.log.info('Telnyx WS closed', { code, reason });
		this.cleanup();
	}

	async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
		this.log.error('Telnyx WS error', { error: String(error) });
		this.cleanup();
	}

	// =========================================================================
	// Audio Pipeline (continuous audio + Gemini auto VAD + noise gate)
	// =========================================================================

	private handleAudio(l16Base64: string): void {
		// Fork 1: Send PCM bytes to Deepgram for transcript comparison
		if (this.deepgram?.connected) {
			this.deepgram.sendAudio(this.audio.telnyxToDeepgramBytes(l16Base64));
		}

		// Fork 2: Convert and send to Gemini (continuous — Gemini handles VAD)
		const pcmBase64 = this.audio.telnyxToGemini(l16Base64);

		if (this.gemini?.connected) {
			this.gemini.sendAudio(pcmBase64);
		} else {
			// Buffer while Gemini is connecting
			this.audioBuffer.push(pcmBase64);
			if (this.audioBuffer.length > 500) {
				this.audioBuffer.splice(0, this.audioBuffer.length - 500);
			}
		}
	}

	private handleGeminiAudio(pcmBase64: string): void {
		if (!this.telnyxWs) return;

		try {
			const l16Base64 = this.audio.geminiToTelnyx(pcmBase64);
			this.telnyxWs.send(JSON.stringify({
				event: 'media',
				media: { payload: l16Base64 },
			}));
		} catch (err) {
			this.log.error('Audio conversion error (Gemini→Telnyx)', { error: String(err) });
		}
	}

	// =========================================================================
	// Service Wiring
	// =========================================================================

	private async connectServices(): Promise<void> {
		// Load config — may need to retry if POST /init hasn't arrived yet
		if (!this.config) {
			this.config = await this.loadConfigWithRetry();
		}
		if (!this.config) {
			this.log.error('Failed to load config after retries — cannot connect services');
			return;
		}

		this.log = this.log.withCallContext({ callId: this.config.callId });
		this.telnyx = new TelnyxService(this.config.telnyxApiKey, this.config.connectionId);

		// Connect Deepgram first (quick, needed before audio arrives)
		await this.connectDeepgram();

		// Connect Gemini (slower, may take a moment)
		await this.connectGemini();
	}

	private async loadConfigWithRetry(): Promise<CallConfig | null> {
		for (let i = 0; i < CONFIG_RETRY_ATTEMPTS; i++) {
			const config = await this.doState.storage.get<CallConfig>('config');
			if (config) return config;

			this.log.debug('Config not found, retrying...', { attempt: i + 1 });
			await new Promise(resolve => setTimeout(resolve, CONFIG_RETRY_DELAY_MS));
		}
		return null;
	}

	private async connectDeepgram(): Promise<void> {
		if (!this.config) return;

		try {
			this.deepgram = new DeepgramVADService(this.config.deepgramApiKey);
			await this.deepgram.connect({
				onSpeechStarted: () => {
					this.log.debug('Speech started (Deepgram)');
				},

				onUtteranceEnd: (transcript: string) => {
					this.log.debug('Utterance end (Deepgram)', { transcript: transcript.slice(0, 100) });
				},

				onEndOfTurn: (transcript: string) => {
					this.log.debug('End of turn (Deepgram)', { transcript: transcript.slice(0, 100) });
					if (transcript) {
						this.transcripts.push({ source: 'deepgram', role: 'user', text: transcript, timestamp: Date.now() });
					}
				},

				onError: (error: Error) => {
					this.log.error('Deepgram error', { error: error.message });
				},
			});
			this.log.info('Deepgram VAD connected');
		} catch (error) {
			this.log.error('Failed to connect Deepgram', { error: String(error) });
		}
	}

	private async connectGemini(): Promise<void> {
		if (!this.config || this.geminiConnecting) return;
		this.geminiConnecting = true;

		try {
			this.gemini = new GeminiLiveService({
				apiKey: this.config.geminiApiKey,
				model: this.config.model,
				voice: this.config.voice,
				systemInstruction: this.config.prompt,
				tools: this.tools.getDefinitions(),
			});

			await this.gemini.connect({
				onAudio: (pcmBase64: string) => {
					this.handleGeminiAudio(pcmBase64);
				},

				onToolCall: (id: string, name: string, args: Record<string, any>) => {
					this.handleToolCall(id, name, args);
				},

				onTranscript: (text: string, role: 'user' | 'model') => {
					this.log.debug(`${role === 'model' ? 'AI' : 'User'} said`, { text: text.slice(0, 200) });
					this.transcripts.push({ source: 'gemini', role, text, timestamp: Date.now() });
				},

				onSetupComplete: () => {
					this.log.info('Gemini setup complete');

					// Discard buffered audio — stale burst confuses auto VAD
					if (this.audioBuffer.length > 0) {
						this.log.info('Discarding stale audio buffer', { packets: this.audioBuffer.length });
						this.audioBuffer = [];
					}

					// For inbound calls, send pre-recorded "Hello" to trigger greeting
					if (this.config?.direction === 'inbound') {
						this.log.info('Inbound call — sending hello audio to trigger greeting');
						this.gemini!.sendAudio(HELLO_AUDIO_PCM_BASE64);
					}
				},

				onTurnComplete: () => {
					this.log.debug('Turn complete');

					// Handle pending end_call
					if (this.pendingEndCall) {
						this.executeEndCall();
					}
				},

				onInterrupted: () => {
					this.log.debug('AI interrupted by user');
				},

				onError: (error: Error) => {
					this.log.error('Gemini error', { error: error.message });
				},

				onToolCallCancellation: (ids: string[]) => {
					this.log.info('Tool calls cancelled', { ids });
				},
			});

			this.log.info('Gemini connected');
		} catch (error) {
			this.log.error('Failed to connect Gemini', { error: String(error) });
		} finally {
			this.geminiConnecting = false;
		}
	}

	// =========================================================================
	// Tool Handling
	// =========================================================================

	private async handleToolCall(id: string, name: string, args: Record<string, any>): Promise<void> {
		this.log.info('Tool call', { name, id });

		const result = await this.tools.execute(name, args, {
			callId: this.config?.callId ?? '',
			callControlId: this.callControlId,
			hangup: async () => {
				if (this.callControlId && this.telnyx) {
					await this.telnyx.hangup(this.callControlId);
				}
			},
			setPendingEndCall: () => {
				this.pendingEndCall = true;
			},
		});

		// Send tool response back to Gemini
		if (this.gemini?.connected) {
			this.gemini.sendToolResponse(id, name, result.data ?? { status: result.success ? 'ok' : 'error' });
		}
	}

	// =========================================================================
	// End Call
	// =========================================================================

	private executeEndCall(): void {
		this.log.info('Executing end call');

		// Telnyx has no mark mechanism, so use a simple delay
		setTimeout(async () => {
			try {
				if (this.callControlId && this.telnyx) {
					await this.telnyx.hangup(this.callControlId);
				}
			} catch (err) {
				this.log.error('Hangup failed', { error: String(err) });
			}
			this.cleanup();
		}, END_CALL_DELAY_MS);
	}

	// =========================================================================
	// Webhook Events
	// =========================================================================

	private async handleEvent(request: Request): Promise<Response> {
		const body: any = await request.json();
		const eventType = body?.data?.event_type ?? body?.event_type ?? 'unknown';
		const payload = body?.data?.payload ?? body?.payload ?? body;

		this.log.info('Event', { eventType });

		switch (eventType) {
			case 'call.initiated':
				this.callControlId = payload.call_control_id;
				break;

			case 'call.answered':
				this.callControlId = payload.call_control_id;
				break;

			case 'call.hangup':
				this.cleanup();
				break;

			case 'call.streaming.started':
				this.log.info('Streaming started');
				break;

			case 'call.streaming.stopped':
				this.log.info('Streaming stopped');
				break;
		}

		return Response.json({ ok: true });
	}

	// =========================================================================
	// Cleanup
	// =========================================================================

	private cleanup(): void {
		// Persist transcripts to storage before clearing services
		if (this.transcripts.length > 0) {
			this.doState.storage.put('transcripts', this.transcripts);
		}

		if (this.gemini) {
			try { this.gemini.close(); } catch { /* ignore */ }
			this.gemini = null;
		}
		if (this.deepgram) {
			try { this.deepgram.close(); } catch { /* ignore */ }
			this.deepgram = null;
		}
		this.telnyxWs = null;
		this.audioBuffer = [];
		this.pendingEndCall = false;
	}
}
