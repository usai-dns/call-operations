/**
 * Audio codec conversion utilities for bridging Telnyx (mu-law 8kHz) and Gemini (linear PCM).
 *
 * Telnyx streaming sends/receives: mu-law (G.711u) 8kHz mono, base64-encoded
 * Gemini Live API sends/receives: linear PCM 16-bit LE, 24kHz (output) / accepts 16kHz (input)
 */

// ── mu-law decode table (mu-law byte → 16-bit linear PCM sample) ──
const MULAW_DECODE = new Int16Array(256);
(function buildMulawTable() {
  for (let i = 0; i < 256; i++) {
    let mu = ~i & 0xff;
    const sign = mu & 0x80 ? -1 : 1;
    mu = mu & 0x7f;
    const exponent = (mu >> 4) & 0x07;
    const mantissa = mu & 0x0f;
    let sample = ((mantissa << 1) + 33) << (exponent + 2);
    sample -= 0x84;
    MULAW_DECODE[i] = sign * sample;
  }
})();

// ── Linear PCM → mu-law encode ──
const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

function linearToMulaw(sample: number): number {
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;

  let exponent = 7;
  const expMask = 0x4000;
  for (; exponent > 0; exponent--) {
    if (sample & (expMask >> (7 - exponent))) break;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const mulawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return mulawByte;
}

/**
 * Decode mu-law bytes to 16-bit PCM samples.
 */
export function mulawToPcm16(mulawBytes: Uint8Array): Int16Array {
  const pcm = new Int16Array(mulawBytes.length);
  for (let i = 0; i < mulawBytes.length; i++) {
    pcm[i] = MULAW_DECODE[mulawBytes[i]];
  }
  return pcm;
}

/**
 * Encode 16-bit PCM samples to mu-law bytes.
 */
export function pcm16ToMulaw(pcmSamples: Int16Array): Uint8Array {
  const mulaw = new Uint8Array(pcmSamples.length);
  for (let i = 0; i < pcmSamples.length; i++) {
    mulaw[i] = linearToMulaw(pcmSamples[i]);
  }
  return mulaw;
}

/**
 * Upsample from 8kHz to 16kHz using linear interpolation.
 * Gemini accepts 16kHz input which is a clean 2x upsample from Telnyx's 8kHz.
 */
export function upsample8kTo16k(samples: Int16Array): Int16Array {
  const out = new Int16Array(samples.length * 2);
  for (let i = 0; i < samples.length - 1; i++) {
    out[i * 2] = samples[i];
    out[i * 2 + 1] = ((samples[i] + samples[i + 1]) >> 1) as number;
  }
  // Last sample
  out[(samples.length - 1) * 2] = samples[samples.length - 1];
  out[(samples.length - 1) * 2 + 1] = samples[samples.length - 1];
  return out;
}

/**
 * Downsample from 24kHz to 8kHz by taking every 3rd sample.
 * Simple decimation — sufficient for voice audio.
 */
export function downsample24kTo8k(samples: Int16Array): Int16Array {
  const outLen = Math.floor(samples.length / 3);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    out[i] = samples[i * 3];
  }
  return out;
}

/**
 * Full pipeline: Telnyx mu-law base64 → Gemini PCM16 base64 (16kHz)
 */
export function telnyxToGemini(base64Mulaw: string): string {
  const mulawBytes = base64ToUint8Array(base64Mulaw);
  const pcm8k = mulawToPcm16(mulawBytes);
  const pcm16k = upsample8kTo16k(pcm8k);
  return int16ArrayToBase64(pcm16k);
}

/**
 * Full pipeline: Gemini PCM16 base64 (24kHz) → Telnyx mu-law base64 (8kHz)
 */
export function geminiToTelnyx(base64Pcm: string): string {
  const pcmBytes = base64ToUint8Array(base64Pcm);
  // Gemini sends 16-bit LE PCM, convert byte array to Int16Array
  const pcm24k = new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.length >> 1);
  const pcm8k = downsample24kTo8k(pcm24k);
  const mulaw = pcm16ToMulaw(pcm8k);
  return uint8ArrayToBase64(mulaw);
}

// ── Base64 helpers ──

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function int16ArrayToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  return uint8ArrayToBase64(bytes);
}
