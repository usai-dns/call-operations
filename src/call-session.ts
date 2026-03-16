import type { Env, CallState } from "./types";

/** Durable Object managing a single phone call's lifecycle and media streaming */
export class CallSession implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private callState: CallState | null = null;

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

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Telnyx sends JSON frames with media data
    if (typeof message === "string") {
      try {
        const data = JSON.parse(message);
        console.log(`[CallSession] WS message event: ${data.event}`);

        if (data.event === "media") {
          // Forward audio to Gemini (will be implemented)
          // For now, log it
          console.log(`[CallSession] Received media chunk, track: ${data.media?.track}`);
        }
      } catch {
        console.warn("[CallSession] Non-JSON WS message");
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    console.log(`[CallSession] WS closed: ${code} ${reason}`);
    if (this.callState) {
      this.callState.status = "ended";
      this.callState.endedAt = Date.now();
      await this.state.storage.put("callState", this.callState);
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("[CallSession] WS error:", error);
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
