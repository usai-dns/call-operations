import type { Env, CallState } from "./types";
import { geminiWsUrl, buildSetupMessage, parseGeminiResponse } from "./gemini";
import { telnyxToGemini, geminiToTelnyx } from "./audio";

const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI phone assistant. You are answering a live phone call.
Be conversational, friendly, and concise. Keep responses brief since this is a voice conversation.
If the caller asks who you are, say you are an AI assistant.`;

/** Durable Object managing a single phone call's lifecycle and media streaming */
export class CallSession implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private callState: CallState | null = null;

  // WebSocket references
  private telnyxWs: WebSocket | null = null;
  private geminiWs: WebSocket | null = null;
  private geminiReady = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade for Telnyx media stream
    if (url.pathname === "/ws" && request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocket(request);
    }

    // Initialize call state
    if (url.pathname === "/init" && request.method === "POST") {
      this.callState = await request.json() as CallState;
      await this.state.storage.put("callState", this.callState);
      return Response.json({ ok: true, state: this.callState });
    }

    // Get current state
    if (url.pathname === "/state") {
      const stored = this.callState ?? await this.state.storage.get<CallState>("callState");
      return Response.json({ state: stored ?? null });
    }

    // Handle Telnyx webhook event for this call
    if (url.pathname === "/event" && request.method === "POST") {
      return this.handleEvent(request);
    }

    return Response.json({ error: "not found" }, { status: 404 });
  }

  private handleWebSocket(_request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server);
    this.telnyxWs = server;

    // Connect to Gemini once Telnyx WS is established
    this.connectGemini();

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Open an outbound WebSocket to Gemini Live API */
  private async connectGemini(): Promise<void> {
    const url = geminiWsUrl(this.env.GEMINI_API_TOKEN);

    try {
      const resp = await fetch(url, {
        headers: { Upgrade: "websocket" },
      });

      const ws = resp.webSocket;
      if (!ws) {
        console.error(`[CallSession] Failed to establish Gemini WebSocket — no webSocket on response. Status: ${resp.status}, statusText: ${resp.statusText}`);
        const text = await resp.text().catch(() => "could not read body");
        console.error(`[CallSession] Response body: ${text}`);
        return;
      }

      ws.accept();
      this.geminiWs = ws;
      console.log("[CallSession] Gemini WebSocket connected successfully");

      // Send setup message
      const systemPrompt = this.callState?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
      const setupMsg = buildSetupMessage(systemPrompt);
      ws.send(JSON.stringify(setupMsg));
      console.log("[CallSession] Gemini setup message sent, awaiting setup_complete");

      // Listen for Gemini responses
      ws.addEventListener("message", (event) => {
        this.handleGeminiMessage(event.data as string);
      });

      ws.addEventListener("close", (event) => {
        console.log(`[CallSession] Gemini WS closed: ${event.code} ${event.reason}`);
        this.geminiWs = null;
        this.geminiReady = false;
      });

      ws.addEventListener("error", (event) => {
        console.error("[CallSession] Gemini WS error:", event);
        this.geminiWs = null;
        this.geminiReady = false;
      });
    } catch (err) {
      console.error("[CallSession] Failed to connect to Gemini:", err);
    }
  }

  /** Process a message received from Gemini */
  private handleGeminiMessage(raw: string): void {
    const parsed = parseGeminiResponse(raw);

    switch (parsed.type) {
      case "setup_complete":
        console.log("[CallSession] Gemini setup complete — ready for audio");
        this.geminiReady = true;
        break;

      case "audio":
        if (parsed.audioData && this.telnyxWs) {
          // Convert Gemini PCM 24kHz → Telnyx mu-law 8kHz and send back
          try {
            const mulawBase64 = geminiToTelnyx(parsed.audioData);
            this.telnyxWs.send(JSON.stringify({
              event: "media",
              media: {
                track: "outbound",
                payload: mulawBase64,
              },
            }));
          } catch (err) {
            console.error("[CallSession] Audio conversion error (Gemini→Telnyx):", err);
          }
        }
        break;

      case "text":
        console.log(`[CallSession] Gemini text: ${parsed.text}`);
        break;

      case "turn_complete":
        console.log("[CallSession] Gemini turn complete");
        break;

      default:
        break;
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Telnyx sends JSON frames with media data
    if (typeof message === "string") {
      try {
        const data = JSON.parse(message);

        if (data.event === "media" && data.media?.payload) {
          // Forward audio from Telnyx to Gemini
          if (!this.geminiReady) {
            console.log("[CallSession] Received Telnyx audio but Gemini not ready yet");
          }
          if (this.geminiWs && this.geminiReady) {
            try {
              const pcmBase64 = telnyxToGemini(data.media.payload);
              this.geminiWs.send(JSON.stringify({
                realtimeInput: {
                  mediaChunks: [{
                    mimeType: "audio/pcm;rate=16000",
                    data: pcmBase64,
                  }],
                },
              }));
            } catch (err) {
              console.error("[CallSession] Audio conversion error (Telnyx→Gemini):", err);
            }
          }
        } else if (data.event === "start") {
          console.log(`[CallSession] Telnyx stream started, streamId: ${data.stream_id}`);
        } else if (data.event === "stop") {
          console.log("[CallSession] Telnyx stream stopped");
          this.cleanup();
        } else {
          console.log(`[CallSession] Telnyx WS event: ${data.event}`);
        }
      } catch {
        console.warn("[CallSession] Non-JSON WS message");
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    console.log(`[CallSession] Telnyx WS closed: ${code} ${reason}`);
    this.cleanup();
    if (this.callState) {
      this.callState.status = "ended";
      this.callState.endedAt = Date.now();
      await this.state.storage.put("callState", this.callState);
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("[CallSession] Telnyx WS error:", error);
    this.cleanup();
  }

  /** Clean up Gemini connection when call ends */
  private cleanup(): void {
    if (this.geminiWs) {
      try {
        this.geminiWs.close(1000, "call ended");
      } catch { /* ignore */ }
      this.geminiWs = null;
      this.geminiReady = false;
    }
    this.telnyxWs = null;
  }

  private async handleEvent(request: Request): Promise<Response> {
    const body: any = await request.json();
    const eventType = body?.data?.event_type ?? body?.event_type ?? "unknown";
    const payload = body?.data?.payload ?? body?.payload ?? body;

    console.log(`[CallSession] Event: ${eventType}`);

    if (!this.callState) {
      this.callState = await this.state.storage.get<CallState>("callState") ?? null;
    }

    switch (eventType) {
      case "call.initiated":
        if (this.callState) {
          this.callState.callControlId = payload.call_control_id;
          this.callState.status = "ringing";
          await this.state.storage.put("callState", this.callState);
        }
        break;

      case "call.answered":
        if (this.callState) {
          this.callState.status = "answered";
          await this.state.storage.put("callState", this.callState);
        }
        break;

      case "call.hangup":
        if (this.callState) {
          this.callState.status = "ended";
          this.callState.endedAt = Date.now();
          await this.state.storage.put("callState", this.callState);
        }
        this.cleanup();
        break;

      case "call.streaming.started":
        if (this.callState) {
          this.callState.status = "streaming";
          await this.state.storage.put("callState", this.callState);
        }
        break;

      case "call.streaming.stopped":
        console.log("[CallSession] Streaming stopped");
        break;

      default:
        console.log(`[CallSession] Unhandled event: ${eventType}`);
    }

    return Response.json({ ok: true });
  }
}
