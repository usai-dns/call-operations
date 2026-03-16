import type { GeminiSessionConfig } from "./types";

// Cloudflare Workers require https:// (not wss://) for outbound WebSocket fetch()
const GEMINI_WS_BASE = "https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/** Build the Gemini Audio Live WebSocket URL */
export function geminiWsUrl(apiToken: string): string {
  return `${GEMINI_WS_BASE}?key=${apiToken}`;
}

/** Build the setup message for a Gemini Audio Live session */
export function buildSetupMessage(systemPrompt?: string): object {
  const config: GeminiSessionConfig = {
    model: "models/gemini-2.0-flash-live-001",
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: "Kore" },
        },
      },
    },
  };

  if (systemPrompt) {
    config.systemInstruction = {
      parts: [{ text: systemPrompt }],
    };
  }

  return { setup: config };
}

/** Convert Telnyx mu-law 8kHz audio to PCM16 base64 for Gemini */
export function telnyxMediaToGeminiChunk(base64Audio: string): object {
  return {
    realtimeInput: {
      mediaChunks: [
        {
          mimeType: "audio/pcm;rate=8000",
          data: base64Audio,
        },
      ],
    },
  };
}

/** Send a text message to Gemini as client content */
export function textToGeminiContent(text: string): object {
  return {
    clientContent: {
      turns: [{ role: "user", parts: [{ text }] }],
      turnComplete: true,
    },
  };
}

/** Parse a Gemini server message, extract audio data if present */
export function parseGeminiResponse(message: string): {
  type: "audio" | "text" | "setup_complete" | "turn_complete" | "other";
  audioData?: string;
  text?: string;
} {
  try {
    const data = JSON.parse(message);

    if (data.setupComplete !== undefined) {
      return { type: "setup_complete" };
    }

    if (data.serverContent?.turnComplete) {
      return { type: "turn_complete" };
    }

    const parts = data.serverContent?.modelTurn?.parts;
    if (parts) {
      for (const part of parts) {
        if (part.inlineData?.mimeType?.startsWith("audio/")) {
          return { type: "audio", audioData: part.inlineData.data };
        }
        if (part.text) {
          return { type: "text", text: part.text };
        }
      }
    }

    return { type: "other" };
  } catch {
    return { type: "other" };
  }
}
