import { logger as _logger } from '../utils/logger';

export interface DeepgramVADCallbacks {
	onSpeechStarted?: () => void;
	onUtteranceEnd?: (transcript: string) => void;
	onEndOfTurn?: (transcript: string) => void;
	onError?: (error: Error) => void;
}

interface FluxTurnInfo {
	type: 'TurnInfo';
	event: 'StartOfTurn' | 'EndOfTurn' | 'Update' | 'EagerEndOfTurn' | 'TurnResumed';
	transcript: string;
	end_of_turn_confidence: number;
	turn_index: number;
}

export class DeepgramVADService {
	private ws: WebSocket | null = null;
	private apiKey: string;
	private callbacks: DeepgramVADCallbacks = {};
	private isConnected = false;
	private isSpeaking = false;
	private turnIndex = 0;
	private firstTurnFallbackTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly FIRST_TURN_FALLBACK_MS = 2000;

	private audioPacketsReceived = 0;
	private hasReceivedAnyTurnInfo = false;
	private missedFirstTurnTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly MISSED_FIRST_TURN_CHECK_MS = 3000;

	private currentTurnTranscript = '';

	constructor(apiKey: string) {
		this.apiKey = apiKey;
	}

	async connect(callbacks: DeepgramVADCallbacks): Promise<void> {
		this.callbacks = callbacks;

		const url = 'wss://api.deepgram.com/v2/listen?' + new URLSearchParams({
			model: 'flux-general-en',
			encoding: 'linear16',
			sample_rate: '8000',
			eager_eot_threshold: '0.5',
			eot_threshold: '0.8',
			eot_timeout_ms: '3000',
		});

		_logger.debug('Connecting to Deepgram Flux', { context: 'DeepgramVAD' });

		return new Promise((resolve, reject) => {
			this.ws = new WebSocket(url, ['token', this.apiKey]);

			this.ws.addEventListener('open', () => {
				_logger.debug('Connected to Flux successfully', { context: 'DeepgramVAD' });
				this.isConnected = true;
				resolve();
			});

			this.ws.addEventListener('message', (event) => {
				this.handleMessage(event.data);
			});

			this.ws.addEventListener('close', (event) => {
				_logger.debug('WebSocket closed', { context: 'DeepgramVAD', code: event.code, reason: event.reason });
				this.isConnected = false;
				this.ws = null;
			});

			this.ws.addEventListener('error', (event) => {
				_logger.error('WebSocket error', { context: 'DeepgramVAD' });
				const error = new Error('Deepgram Flux connection error');
				this.callbacks.onError?.(error);
				if (!this.isConnected) {
					reject(error);
				}
			});
		});
	}

	private handleMessage(data: string | ArrayBuffer): void {
		try {
			const message = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));

			if (message.type === 'TurnInfo') {
				const turnInfo = message as FluxTurnInfo;

				if (!this.hasReceivedAnyTurnInfo) {
					this.hasReceivedAnyTurnInfo = true;
					this.clearMissedFirstTurnTimer();
					_logger.debug('First TurnInfo received - VAD is working', { context: 'DeepgramVAD' });
				}

				switch (turnInfo.event) {
					case 'StartOfTurn':
						if (!this.isSpeaking) {
							this.isSpeaking = true;
							this.currentTurnTranscript = turnInfo.transcript || '';
							_logger.debug('StartOfTurn - signaling speech started', { context: 'DeepgramVAD', turn: this.turnIndex });
							this.callbacks.onSpeechStarted?.();

							if (this.turnIndex === 0) {
								this.firstTurnFallbackTimer = setTimeout(() => {
									if (this.isSpeaking && this.turnIndex === 0) {
										_logger.debug('First turn fallback triggered', { context: 'DeepgramVAD' });
										this.isSpeaking = false;
										this.callbacks.onUtteranceEnd?.(this.currentTurnTranscript);
									}
								}, this.FIRST_TURN_FALLBACK_MS);
							}
						}
						break;

					case 'Update':
						if (turnInfo.transcript) {
							this.currentTurnTranscript = turnInfo.transcript;
						}
						break;

					case 'EagerEndOfTurn':
						this.clearFirstTurnTimer();
						_logger.debug('EagerEndOfTurn - waiting for EndOfTurn', { context: 'DeepgramVAD' });
						break;

					case 'TurnResumed':
						_logger.debug('TurnResumed - user continued speaking', { context: 'DeepgramVAD' });
						if (!this.isSpeaking) {
							this.isSpeaking = true;
							this.callbacks.onSpeechStarted?.();
						}
						break;

					case 'EndOfTurn':
						this.clearFirstTurnTimer();
						this.turnIndex++;
						const finalTranscript = turnInfo.transcript || this.currentTurnTranscript;
						_logger.debug('EndOfTurn', { context: 'DeepgramVAD', transcript: finalTranscript });
						if (this.isSpeaking) {
							this.isSpeaking = false;
							// Delay 200ms to let in-flight audio packets flush to Gemini
							// before signaling utterance end (which triggers activityEnd)
							const transcript = finalTranscript;
							setTimeout(() => {
								this.callbacks.onUtteranceEnd?.(transcript);
							}, 200);
						}
						this.callbacks.onEndOfTurn?.(finalTranscript);
						this.currentTurnTranscript = '';
						break;
				}
				return;
			}

			if (message.type === 'Metadata') return;
			if (message.type === 'Error') {
				_logger.error('Error from Deepgram', { context: 'DeepgramVAD', deepgramError: message });
			}

		} catch (error) {
			_logger.error('Failed to parse message', { context: 'DeepgramVAD', error: String(error) });
		}
	}

	sendAudio(pcmBuffer: ArrayBuffer): void {
		if (!this.ws || !this.isConnected) return;

		try {
			this.audioPacketsReceived++;

			if (this.audioPacketsReceived === 1 && !this.missedFirstTurnTimer) {
				this.missedFirstTurnTimer = setTimeout(() => {
					this.checkForMissedFirstTurn();
				}, this.MISSED_FIRST_TURN_CHECK_MS);
			}

			this.ws.send(pcmBuffer);
		} catch (error) {
			_logger.error('Error sending audio', { context: 'DeepgramVAD', error: String(error) });
		}
	}

	private checkForMissedFirstTurn(): void {
		this.missedFirstTurnTimer = null;

		if (this.audioPacketsReceived > 100 && !this.hasReceivedAnyTurnInfo && this.turnIndex === 0) {
			_logger.warn('MISSED FIRST TURN DETECTED - forcing activityStart + activityEnd', { context: 'DeepgramVAD', audioPackets: this.audioPacketsReceived });
			this.callbacks.onSpeechStarted?.();
			setTimeout(() => {
				this.callbacks.onUtteranceEnd?.('');
				this.turnIndex = 1;
			}, 100);
		}
	}

	private clearFirstTurnTimer(): void {
		if (this.firstTurnFallbackTimer) {
			clearTimeout(this.firstTurnFallbackTimer);
			this.firstTurnFallbackTimer = null;
		}
	}

	private clearMissedFirstTurnTimer(): void {
		if (this.missedFirstTurnTimer) {
			clearTimeout(this.missedFirstTurnTimer);
			this.missedFirstTurnTimer = null;
		}
	}

	get connected(): boolean { return this.isConnected; }
	get speaking(): boolean { return this.isSpeaking; }

	close(): void {
		this.clearFirstTurnTimer();
		this.clearMissedFirstTurnTimer();
		if (this.ws) {
			try { this.ws.send(JSON.stringify({ type: 'CloseStream' })); } catch { /* ignore */ }
			this.ws.close();
			this.ws = null;
			this.isConnected = false;
			this.isSpeaking = false;
		}
	}
}
