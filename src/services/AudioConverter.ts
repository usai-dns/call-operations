/**
 * Audio Converter — mulaw/8kHz ↔ PCM/16kHz-24kHz
 *
 * Telnyx (PCMU) → Gemini: mulaw/8kHz → PCM/16kHz (2x upsample)
 * Gemini → Telnyx: PCM/24kHz → mulaw/8kHz (3x downsample)
 *
 * Simplified from production — no background audio mixing.
 */

// Pre-computed mulaw decode table (256 entries)
const MULAW_DECODE_TABLE: Int16Array = new Int16Array([
	-32124, -31100, -30076, -29052, -28028, -27004, -25980, -24956,
	-23932, -22908, -21884, -20860, -19836, -18812, -17788, -16764,
	-15996, -15484, -14972, -14460, -13948, -13436, -12924, -12412,
	-11900, -11388, -10876, -10364, -9852, -9340, -8828, -8316,
	-7932, -7676, -7420, -7164, -6908, -6652, -6396, -6140,
	-5884, -5628, -5372, -5116, -4860, -4604, -4348, -4092,
	-3900, -3772, -3644, -3516, -3388, -3260, -3132, -3004,
	-2876, -2748, -2620, -2492, -2364, -2236, -2108, -1980,
	-1884, -1820, -1756, -1692, -1628, -1564, -1500, -1436,
	-1372, -1308, -1244, -1180, -1116, -1052, -988, -924,
	-876, -844, -812, -780, -748, -716, -684, -652,
	-620, -588, -556, -524, -492, -460, -428, -396,
	-372, -356, -340, -324, -308, -292, -276, -260,
	-244, -228, -212, -196, -180, -164, -148, -132,
	-120, -112, -104, -96, -88, -80, -72, -64,
	-56, -48, -40, -32, -24, -16, -8, 0,
	32124, 31100, 30076, 29052, 28028, 27004, 25980, 24956,
	23932, 22908, 21884, 20860, 19836, 18812, 17788, 16764,
	15996, 15484, 14972, 14460, 13948, 13436, 12924, 12412,
	11900, 11388, 10876, 10364, 9852, 9340, 8828, 8316,
	7932, 7676, 7420, 7164, 6908, 6652, 6396, 6140,
	5884, 5628, 5372, 5116, 4860, 4604, 4348, 4092,
	3900, 3772, 3644, 3516, 3388, 3260, 3132, 3004,
	2876, 2748, 2620, 2492, 2364, 2236, 2108, 1980,
	1884, 1820, 1756, 1692, 1628, 1564, 1500, 1436,
	1372, 1308, 1244, 1180, 1116, 1052, 988, 924,
	876, 844, 812, 780, 748, 716, 684, 652,
	620, 588, 556, 524, 492, 460, 428, 396,
	372, 356, 340, 324, 308, 292, 276, 260,
	244, 228, 212, 196, 180, 164, 148, 132,
	120, 112, 104, 96, 88, 80, 72, 64,
	56, 48, 40, 32, 24, 16, 8, 0
]);

// Pre-computed mulaw encode table (65536 entries for O(1) lookup)
const MULAW_ENCODE_TABLE: Uint8Array = (() => {
	const table = new Uint8Array(65536);
	const MULAW_BIAS = 0x84;
	const MULAW_CLIP = 32635;

	for (let i = 0; i < 65536; i++) {
		let sample = i < 32768 ? i : i - 65536;
		const sign = (sample < 0) ? 0x80 : 0;
		if (sample < 0) sample = -sample;
		if (sample > MULAW_CLIP) sample = MULAW_CLIP;
		sample += MULAW_BIAS;

		let exponent = 7;
		let mask = 0x4000;
		while (exponent > 0 && (sample & mask) === 0) {
			exponent--;
			mask >>= 1;
		}

		const mantissa = (sample >> (exponent + 3)) & 0x0F;
		table[i] = ~(sign | (exponent << 4) | mantissa) & 0xFF;
	}
	return table;
})();

function linearToMulaw(sample: number): number {
	if (sample > 32767) sample = 32767;
	if (sample < -32768) sample = -32768;
	const index = sample < 0 ? sample + 65536 : sample;
	return MULAW_ENCODE_TABLE[index];
}

export class AudioConverter {
	/** Convert Telnyx mulaw/8kHz base64 → Gemini PCM/16kHz base64 */
	mulawToGemini(mulawBase64: string): string {
		const mulawBytes = this.base64ToUint8Array(mulawBase64);

		// Decode mulaw to PCM (8kHz)
		const pcm8k = new Int16Array(mulawBytes.length);
		for (let i = 0; i < mulawBytes.length; i++) {
			pcm8k[i] = MULAW_DECODE_TABLE[mulawBytes[i]];
		}

		// Upsample 8kHz → 16kHz (linear interpolation)
		const pcm16k = new Int16Array(pcm8k.length * 2);
		for (let i = 0; i < pcm8k.length; i++) {
			const curr = pcm8k[i];
			const next = i < pcm8k.length - 1 ? pcm8k[i + 1] : curr;
			pcm16k[i * 2] = curr;
			pcm16k[i * 2 + 1] = Math.round((curr + next) / 2);
		}

		// Encode as base64 LE PCM
		const bytes = new Uint8Array(pcm16k.length * 2);
		const view = new DataView(bytes.buffer);
		for (let i = 0; i < pcm16k.length; i++) {
			view.setInt16(i * 2, pcm16k[i], true);
		}

		return this.uint8ArrayToBase64(bytes);
	}

	/** Convert Gemini PCM/24kHz base64 → Telnyx mulaw/8kHz base64 */
	geminiToMulaw(pcmBase64: string): string {
		const bytes = this.base64ToUint8Array(pcmBase64);

		// Decode PCM LE to samples
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
		const outputLength = Math.floor(filtered.length / 3);
		const pcm8k = new Int16Array(outputLength);
		for (let i = 0; i < outputLength; i++) {
			pcm8k[i] = filtered[i * 3];
		}

		// Encode as mulaw
		const mulaw = new Uint8Array(pcm8k.length);
		for (let i = 0; i < pcm8k.length; i++) {
			mulaw[i] = linearToMulaw(pcm8k[i]);
		}

		return this.uint8ArrayToBase64(mulaw);
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
