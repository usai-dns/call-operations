import type { Env, TelnyxWebhookEvent, OutboundCallRequest, OutboundSmsRequest, TelnyxCallPayload } from './types';
import { resolveOutboundConfig, resolveInboundConfig } from './config';
import { TelnyxService } from './services/TelnyxService';
import { configureDefaultLogger } from './utils/logger';

export { CallSession } from './durableObjects/CallSession';
export { SmsSession } from './sms/SmsSession';

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		configureDefaultLogger(env as unknown as Record<string, unknown>);

		const url = new URL(request.url);
		const path = url.pathname;

		// CORS
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Authorization',
				},
			});
		}

		try {
			// ── Health ──
			if (path === '/' || path === '/health') {
				return Response.json({
					service: 'call-operations',
					status: 'ok',
					timestamp: new Date().toISOString(),
				});
			}

			// ── Outbound Call ──
			if (path === '/call/outbound' && request.method === 'POST') {
				const body = await request.json() as OutboundCallRequest;
				if (!body.to) {
					return Response.json({ error: "missing 'to' field" }, { status: 400 });
				}

				const telnyx = new TelnyxService(env.TELNYX_API_KEY, env.TELNYX_CONNECTION_ID);
				const webhookUrl = url.origin.replace(/^http:/, 'https:');
				const from = body.from ?? env.TELNYX_PHONE_NUMBER;

				// Dial via Telnyx
				const result = await telnyx.dial(body.to, from, webhookUrl);

				// Resolve config and init DO
				const config = resolveOutboundConfig(body, env, result.callSessionId);
				config.from = from;

				const doId = env.CALL_SESSION.idFromName(result.callSessionId);
				const callDO = env.CALL_SESSION.get(doId);
				await callDO.fetch(new Request('https://do/init', {
					method: 'POST',
					body: JSON.stringify(config),
				}));

				return Response.json({
					ok: true,
					callControlId: result.callControlId,
					callSessionId: result.callSessionId,
				});
			}

			// ── Send SMS ──
			if (path === '/sms/send' && request.method === 'POST') {
				const body = await request.json() as OutboundSmsRequest;
				if (!body.to || !body.text) {
					return Response.json({ error: "missing 'to' or 'text'" }, { status: 400 });
				}

				const smsId = env.SMS_SESSION.idFromName(body.to);
				const smsDO = env.SMS_SESSION.get(smsId);
				const resp = await smsDO.fetch(new Request('https://do/send', {
					method: 'POST',
					body: JSON.stringify({
						to: body.to,
						from: body.from ?? env.TELNYX_PHONE_NUMBER,
						text: body.text,
						mediaUrls: body.mediaUrls,
					}),
				}));
				return resp;
			}

			// ── Telnyx Call Webhook ──
			if (path === '/webhook/call' && request.method === 'POST') {
				const event = await request.json() as TelnyxWebhookEvent;
				const eventType = event.data?.event_type;
				const payload = event.data?.payload as TelnyxCallPayload;

				const webhookReceivedAt = Date.now();
				// ngrok forwards as http — force https for Telnyx webhook URLs
				const externalOrigin = url.origin.replace(/^http:/, 'https:');
				console.log(`[Webhook] origin=${externalOrigin}`);
				console.log(`[Webhook] ${eventType}`, payload ? JSON.stringify({
					direction: (payload as any).direction,
					call_control_id: (payload as any).call_control_id,
					call_session_id: (payload as any).call_session_id,
					from: (payload as any).from,
					to: (payload as any).to,
					state: (payload as any).state,
				}) : 'no payload');

				if (!payload) {
					return Response.json({ ok: true });
				}

				const sessionId = payload.call_session_id ?? payload.call_control_id ?? 'unknown';

				// Inbound call — answer and init DO
				if (eventType === 'call.initiated' && payload.direction === 'incoming') {
					console.log(`[Webhook] Answering inbound call ${payload.call_control_id}...`);
					const answerStart = Date.now();
					const telnyx = new TelnyxService(env.TELNYX_API_KEY, env.TELNYX_CONNECTION_ID);
					try {
						await telnyx.answer(payload.call_control_id, externalOrigin);
						console.log(`[Webhook] Answer succeeded in ${Date.now() - answerStart}ms`);
					} catch (err) {
						console.error(`[Webhook] Answer failed after ${Date.now() - answerStart}ms:`, err);
					}

					// Init DO with inbound config
					const config = resolveInboundConfig(
						{ from: payload.from, to: payload.to },
						env,
						sessionId
					);

					const doId = env.CALL_SESSION.idFromName(sessionId);
					const callDO = env.CALL_SESSION.get(doId);
					await callDO.fetch(new Request('https://do/init', {
						method: 'POST',
						body: JSON.stringify(config),
					}));
				}

				// Call answered — start streaming
				if (eventType === 'call.answered') {
					const streamUrl = `${externalOrigin.replace(/^https:/, 'wss:')}/ws/call-stream/${sessionId}`;
					const telnyx = new TelnyxService(env.TELNYX_API_KEY, env.TELNYX_CONNECTION_ID);
					await telnyx.startStream(payload.call_control_id, streamUrl);
				}

				// Forward all events to DO
				const doId = env.CALL_SESSION.idFromName(sessionId);
				const callDO = env.CALL_SESSION.get(doId);
				await callDO.fetch(new Request('https://do/event', {
					method: 'POST',
					body: JSON.stringify(event),
				}));

				return Response.json({ ok: true });
			}

			// ── Sim Sweep Webhook (test number answers with scripted TTS) ──
			if (path === '/webhook/sim' && request.method === 'POST') {
				const event = await request.json() as TelnyxWebhookEvent;
				const eventType = event.data?.event_type;
				const payload = event.data?.payload as TelnyxCallPayload;

				if (!payload) return Response.json({ ok: true });

				const simHeaders = {
					'Authorization': `Bearer ${env.TELNYX_API_KEY}`,
					'Content-Type': 'application/json',
				};
				const simWebhookUrl = url.origin.replace(/^http:/, 'https:') + '/webhook/sim';

				if (eventType === 'call.initiated' && payload.direction === 'incoming') {
					console.log(`[Sim] Answering sim call ${payload.call_control_id}`);
					await fetch(`https://api.telnyx.com/v2/calls/${payload.call_control_id}/actions/answer`, {
						method: 'POST',
						headers: simHeaders,
						body: JSON.stringify({ webhook_url: simWebhookUrl, webhook_url_method: 'POST' }),
					});
				}

				if (eventType === 'call.answered') {
					console.log(`[Sim] Playing phrase 1 on ${payload.call_control_id}`);
					await fetch(`https://api.telnyx.com/v2/calls/${payload.call_control_id}/actions/speak`, {
						method: 'POST',
						headers: simHeaders,
						body: JSON.stringify({
							payload: 'Hello, how are you doing today?',
							voice: 'female',
							language: 'en-US',
						}),
					});
				}

				if (eventType === 'call.speak.ended') {
					// Track phrase count via client_state
					const phrasesDone = payload.client_state
						? parseInt(atob(payload.client_state), 10) || 0
						: 0;

					if (phrasesDone === 0) {
						console.log(`[Sim] Phrase 1 done, speaking phrase 2`);
						await fetch(`https://api.telnyx.com/v2/calls/${payload.call_control_id}/actions/speak`, {
							method: 'POST',
							headers: simHeaders,
							body: JSON.stringify({
								payload: 'Can you tell me about cats and dogs?',
								voice: 'female',
								language: 'en-US',
								client_state: btoa('1'),
							}),
						});
					} else {
						console.log(`[Sim] All phrases done, hanging up`);
						await fetch(`https://api.telnyx.com/v2/calls/${payload.call_control_id}/actions/hangup`, {
							method: 'POST',
							headers: simHeaders,
							body: JSON.stringify({}),
						});
					}
				}

				return Response.json({ ok: true });
			}

			// ── Telnyx SMS Webhook ──
			if (path === '/webhook/sms' && request.method === 'POST') {
				const event = await request.json() as TelnyxWebhookEvent;
				const eventType = event.data?.event_type;
				const payload: any = event.data?.payload;

				if (eventType === 'message.received' && payload) {
					const from = payload.from?.phone_number ?? payload.from;
					const text = payload.text ?? '';

					const smsId = env.SMS_SESSION.idFromName(from);
					const smsDO = env.SMS_SESSION.get(smsId);
					await smsDO.fetch(new Request('https://do/inbound', {
						method: 'POST',
						body: JSON.stringify({ from, text }),
					}));
				}

				return Response.json({ ok: true });
			}

			// ── WebSocket for Telnyx media streaming ──
			if (path.startsWith('/ws/call-stream/') && request.headers.get('Upgrade') === 'websocket') {
				const sessionId = path.split('/ws/call-stream/')[1];
				if (!sessionId) {
					return Response.json({ error: 'missing session id' }, { status: 400 });
				}

				const doId = env.CALL_SESSION.idFromName(sessionId);
				const callDO = env.CALL_SESSION.get(doId);
				return callDO.fetch(new Request('https://do/ws', {
					headers: request.headers,
				}));
			}

			// ── Get call state ──
			if (path.startsWith('/call/') && path.endsWith('/state') && request.method === 'GET') {
				const sessionId = path.replace('/call/', '').replace('/state', '');
				const doId = env.CALL_SESSION.idFromName(sessionId);
				const callDO = env.CALL_SESSION.get(doId);
				return callDO.fetch(new Request('https://do/state'));
			}

			// ── Get SMS history ──
			if (path.startsWith('/sms/') && path.endsWith('/history') && request.method === 'GET') {
				const phoneNumber = decodeURIComponent(path.replace('/sms/', '').replace('/history', ''));
				const smsId = env.SMS_SESSION.idFromName(phoneNumber);
				const smsDO = env.SMS_SESSION.get(smsId);
				return smsDO.fetch(new Request('https://do/history'));
			}

			return Response.json({ error: 'not found' }, { status: 404 });

		} catch (err: any) {
			console.error('[Worker] Error:', err);
			return Response.json({ error: err.message ?? 'internal error' }, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;
