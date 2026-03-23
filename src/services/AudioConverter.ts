/**
 * Audio Converter — L16/8kHz ↔ PCM/16kHz-24kHz
 *
 * Telnyx L16 is PCM 16-bit LE at 8kHz (telephony rate).
 * No mulaw encode/decode — just sample rate conversion.
 *
 * Telnyx (L16) → Gemini:   PCM 8kHz → upsample 2x → PCM 16kHz
 * Gemini → Telnyx (L16):   PCM 24kHz → downsample 3x → PCM 8kHz
 * Telnyx (L16) → Deepgram: passthrough (linear16, 8kHz)
 */

export class AudioConverter {
	private noiseGateEnabled = true;
	private noiseGateThreshold = 15;
	private silentPacket16k: string | null = null;

	setNoiseGateEnabled(enabled: boolean): void {
		this.noiseGateEnabled = enabled;
	}
	/** Convert Telnyx L16/8kHz base64 → Gemini PCM/16kHz base64 (with noise gate) */
	telnyxToGemini(l16Base64: string): string {
		const bytes = this.base64ToUint8Array(l16Base64);

		// Decode LE PCM samples (8kHz)
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const sampleCount = Math.floor(bytes.length / 2);
		const pcm8k = new Int16Array(sampleCount);
		for (let i = 0; i < sampleCount; i++) {
			pcm8k[i] = view.getInt16(i * 2, true);
		}

		// Noise gate: if RMS energy is below threshold, send silence
		const rms = this.computeRMS(pcm8k);
		this.logRMS(rms);
		if (this.noiseGateEnabled && rms < this.noiseGateThreshold) {
			return this.getSilentPacket(pcm8k.length * 2);
		}

		// Upsample 8kHz → 16kHz (linear interpolation)
		const pcm16k = new Int16Array(pcm8k.length * 2);
		for (let i = 0; i < pcm8k.length; i++) {
			const curr = pcm8k[i];
			const next = i < pcm8k.length - 1 ? pcm8k[i + 1] : curr;
			pcm16k[i * 2] = curr;
			pcm16k[i * 2 + 1] = Math.round((curr + next) / 2);
		}

		// Encode as LE PCM bytes
		const outBytes = new Uint8Array(pcm16k.length * 2);
		const outView = new DataView(outBytes.buffer);
		for (let i = 0; i < pcm16k.length; i++) {
			outView.setInt16(i * 2, pcm16k[i], true);
		}

		return this.uint8ArrayToBase64(outBytes);
	}

	private computeRMS(samples: Int16Array): number {
		let sum = 0;
		for (let i = 0; i < samples.length; i++) {
			sum += samples[i] * samples[i];
		}
		return Math.sqrt(sum / samples.length);
	}

	// Log RMS every ~1 second (50 packets at 20ms each)
	private rmsLogCounter = 0;
	private rmsMin = Infinity;
	private rmsMax = 0;
	private logRMS(rms: number): void {
		this.rmsLogCounter++;
		if (rms < this.rmsMin) this.rmsMin = rms;
		if (rms > this.rmsMax) this.rmsMax = rms;
		if (this.rmsLogCounter % 50 === 0) {
			console.log(`[AudioConverter] RMS range over last 1s: min=${this.rmsMin.toFixed(0)} max=${this.rmsMax.toFixed(0)} threshold=${this.noiseGateThreshold}`);
			this.rmsMin = Infinity;
			this.rmsMax = 0;
		}
	}

	private getSilentPacket(upsampledSamples: number): string {
		if (this.silentPacket16k) return this.silentPacket16k;
		// Cache a silent packet (all zeros)
		const bytes = new Uint8Array(upsampledSamples * 2);
		this.silentPacket16k = this.uint8ArrayToBase64(bytes);
		return this.silentPacket16k;
	}

	/** Convert Telnyx L16/8kHz base64 → LE PCM bytes for Deepgram (passthrough) */
	telnyxToDeepgramBytes(l16Base64: string): ArrayBuffer {
		const bytes = this.base64ToUint8Array(l16Base64);
		return bytes.buffer as ArrayBuffer;
	}

	/** Convert Gemini PCM/24kHz base64 → Telnyx L16/8kHz base64 */
	geminiToTelnyx(pcmBase64: string): string {
		const bytes = this.base64ToUint8Array(pcmBase64);

		// Decode LE PCM samples (24kHz)
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const sampleCount = Math.floor(bytes.length / 2);
		const pcm24k = new Int16Array(sampleCount);
		for (let i = 0; i < sampleCount; i++) {
			pcm24k[i] = view.getInt16(i * 2, true);
		}

		// Low-pass filter before downsampling
		const filtered = new Int16Array(pcm24k.length);
		for (let i = 0; i < pcm24k.length; i++) {
			const prev = i > 0 ? pcm24k[i - 1] : pcm24k[i];
			const next = i < pcm24k.length - 1 ? pcm24k[i + 1] : pcm24k[i];
			filtered[i] = Math.round((prev + pcm24k[i] * 2 + next) / 4);
		}

		// Downsample 24kHz → 8kHz (3x)
		const outputLen = Math.floor(filtered.length / 3);
		const pcm8k = new Int16Array(outputLen);
		for (let i = 0; i < outputLen; i++) {
			pcm8k[i] = filtered[i * 3];
		}

		// Encode as LE PCM bytes
		const outBytes = new Uint8Array(pcm8k.length * 2);
		const outView = new DataView(outBytes.buffer);
		for (let i = 0; i < pcm8k.length; i++) {
			outView.setInt16(i * 2, pcm8k[i], true);
		}

		return this.uint8ArrayToBase64(outBytes);
	}

	private base64ToUint8Array(base64: string): Uint8Array {
		const binaryString = atob(base64);
		const bytes = new Uint8Array(binaryString.length);
		for (let i = 0; i < binaryString.length; i++) {
			bytes[i] = binaryString.charCodeAt(i);
		}
		return bytes;
	}

	private uint8ArrayToBase64(bytes: Uint8Array): string {
		let binary = '';
		for (let i = 0; i < bytes.length; i++) {
			binary += String.fromCharCode(bytes[i]);
		}
		return btoa(binary);
	}
}
