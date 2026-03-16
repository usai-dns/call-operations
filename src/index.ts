import type { Env, TelnyxWebhookEvent, OutboundCallRequest, OutboundSmsRequest } from "./types";
import { dialCall, answerCall, startStream, hangupCall, sendSms, ensureApplication, ensureMessagingProfile } from "./telnyx";

export { CallSession } from "./call-session";
export { SmsSession } from "./sms-session";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers for API calls
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    try {
      // ── Health / Info ──
      if (path === "/" || path === "/health") {
        return Response.json({
          service: "call-operations",
          status: "ok",
          timestamp: new Date().toISOString(),
          routes: [
            "GET  /health",
            "POST /call/outbound",
            "POST /sms/send",
            "POST /webhook/call",
            "POST /webhook/sms",
            "GET  /call/:id/state",
            "GET  /sms/:number/history",
            "POST /provision/application",
            "POST /provision/messaging-profile",
            "WS   /ws/call-stream/:id",
          ],
        });
      }

      // ── Outbound Call ──
      if (path === "/call/outbound" && request.method === "POST") {
        const body = await request.json() as OutboundCallRequest;
        if (!body.to) {
          return Response.json({ error: "missing 'to' field" }, { status: 400 });
        }

        const workerUrl = url.origin;
        const from = body.from ?? env.TELNYX_PHONE_NUMBER;

        const result = await dialCall(
          env,
          body.to,
          from,
          env.TELNYX_CONNECTION_ID,
          workerUrl,
          JSON.stringify({ systemPrompt: body.systemPrompt, firstMessage: body.firstMessage })
        );

        // Initialize Durable Object for this call
        const callId = env.CALL_SESSION.idFromName(result.callSessionId);
        const callDO = env.CALL_SESSION.get(callId);
        await callDO.fetch(new Request("https://do/init", {
          method: "POST",
          body: JSON.stringify({
            callControlId: result.callControlId,
            callSessionId: result.callSessionId,
            direction: "outbound",
            from,
            to: body.to,
            status: "initiating",
            startedAt: Date.now(),
            systemPrompt: body.systemPrompt,
          }),
        }));

        return Response.json({
          ok: true,
          callControlId: result.callControlId,
          callSessionId: result.callSessionId,
        });
      }

      // ── Send SMS ──
      if (path === "/sms/send" && request.method === "POST") {
        const body = await request.json() as OutboundSmsRequest;
        if (!body.to || !body.text) {
          return Response.json({ error: "missing 'to' or 'text'" }, { status: 400 });
        }

        const from = body.from ?? env.TELNYX_PHONE_NUMBER;
        const result = await sendSms(env, body.to, from, body.text, body.mediaUrls);

        // Track in Durable Object
        const smsId = env.SMS_SESSION.idFromName(body.to);
        const smsDO = env.SMS_SESSION.get(smsId);
        await smsDO.fetch(new Request("https://do/send", {
          method: "POST",
          body: JSON.stringify({ to: body.to, from, text: body.text, mediaUrls: body.mediaUrls }),
        }));

        return Response.json({ ok: true, messageId: result.messageId });
      }

      // ── Telnyx Call Webhook ──
      if (path === "/webhook/call" && request.method === "POST") {
        const event = await request.json() as TelnyxWebhookEvent;
        const eventType = event.data?.event_type;
        const payload: any = event.data?.payload;

        console.log(`[Webhook] Call event: ${eventType}`);

        if (!payload) {
          return Response.json({ ok: true });
        }

        const sessionId = payload.call_session_id ?? payload.call_control_id ?? "unknown";

        // Handle incoming call - answer and start streaming
        if (eventType === "call.initiated" && payload.direction === "incoming") {
          const workerUrl = url.origin;
          await answerCall(env, payload.call_control_id, workerUrl);

          // Initialize DO for inbound call
          const callId = env.CALL_SESSION.idFromName(sessionId);
          const callDO = env.CALL_SESSION.get(callId);
          await callDO.fetch(new Request("https://do/init", {
            method: "POST",
            body: JSON.stringify({
              callControlId: payload.call_control_id,
              callSessionId: sessionId,
              direction: "inbound",
              from: payload.from,
              to: payload.to,
              status: "ringing",
              startedAt: Date.now(),
            }),
          }));
        }

        // When call is answered, start media streaming
        if (eventType === "call.answered") {
          const streamUrl = `${url.origin.replace(/^http/, "ws")}/ws/call-stream/${sessionId}`;
          await startStream(env, payload.call_control_id, streamUrl);
        }

        // Forward all events to the call DO
        const callId = env.CALL_SESSION.idFromName(sessionId);
        const callDO = env.CALL_SESSION.get(callId);
        await callDO.fetch(new Request("https://do/event", {
          method: "POST",
          body: JSON.stringify(event),
        }));

        return Response.json({ ok: true });
      }

      // ── Telnyx SMS Webhook ──
      if (path === "/webhook/sms" && request.method === "POST") {
        const event = await request.json() as TelnyxWebhookEvent;
        const eventType = event.data?.event_type;
        const payload: any = event.data?.payload;

        console.log(`[Webhook] SMS event: ${eventType}`);

        if (eventType === "message.received" && payload) {
          const from = payload.from?.phone_number ?? payload.from;
          const text = payload.text ?? "";

          // Route to SMS Durable Object keyed by the sender's number
          const smsId = env.SMS_SESSION.idFromName(from);
          const smsDO = env.SMS_SESSION.get(smsId);
          await smsDO.fetch(new Request("https://do/inbound", {
            method: "POST",
            body: JSON.stringify({ from, text }),
          }));
        }

        return Response.json({ ok: true });
      }

      // ── WebSocket for Telnyx media streaming ──
      if (path.startsWith("/ws/call-stream/") && request.headers.get("Upgrade") === "websocket") {
        const sessionId = path.split("/ws/call-stream/")[1];
        if (!sessionId) {
          return Response.json({ error: "missing session id" }, { status: 400 });
        }

        const callId = env.CALL_SESSION.idFromName(sessionId);
        const callDO = env.CALL_SESSION.get(callId);
        return callDO.fetch(new Request("https://do/ws", {
          headers: request.headers,
        }));
      }

      // ── Get call state ──
      if (path.startsWith("/call/") && path.endsWith("/state") && request.method === "GET") {
        const sessionId = path.replace("/call/", "").replace("/state", "");
        const callId = env.CALL_SESSION.idFromName(sessionId);
        const callDO = env.CALL_SESSION.get(callId);
        const resp = await callDO.fetch(new Request("https://do/state"));
        return resp;
      }

      // ── Get SMS history ──
      if (path.startsWith("/sms/") && path.endsWith("/history") && request.method === "GET") {
        const phoneNumber = decodeURIComponent(path.replace("/sms/", "").replace("/history", ""));
        const smsId = env.SMS_SESSION.idFromName(phoneNumber);
        const smsDO = env.SMS_SESSION.get(smsId);
        const resp = await smsDO.fetch(new Request("https://do/history"));
        return resp;
      }

      // ── Provision: Create Telnyx Application ──
      if (path === "/provision/application" && request.method === "POST") {
        const body: any = await request.json();
        const name = body.name ?? "call-operations";
        const app = await ensureApplication(env, name, url.origin);
        return Response.json({ ok: true, application: app });
      }

      // ── Provision: Create Messaging Profile ──
      if (path === "/provision/messaging-profile" && request.method === "POST") {
        const body: any = await request.json();
        const name = body.name ?? "call-operations-sms";
        const profile = await ensureMessagingProfile(env, name, url.origin);
        return Response.json({ ok: true, messagingProfile: profile });
      }

      return Response.json({ error: "not found" }, { status: 404 });

    } catch (err: any) {
      console.error("[Worker] Error:", err);
      return Response.json(
        { error: err.message ?? "internal error" },
        { status: 500 }
      );
    }
  },
} satisfies ExportedHandler<Env>;
