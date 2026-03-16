import type { Env, SmsConversationState } from '../types';
import { TelnyxService } from '../services/TelnyxService';

export class SmsSession implements DurableObject {
	private state: DurableObjectState;
	private env: Env;
	private conversation: SmsConversationState | null = null;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/init' && request.method === 'POST') {
			const body: any = await request.json();
			this.conversation = {
				phoneNumber: body.phoneNumber,
				messages: [],
				createdAt: Date.now(),
				lastMessageAt: Date.now(),
			};
			await this.state.storage.put('conversation', this.conversation);
			return Response.json({ ok: true });
		}

		if (url.pathname === '/inbound' && request.method === 'POST') {
			return this.handleInbound(request);
		}

		if (url.pathname === '/send' && request.method === 'POST') {
			return this.handleOutbound(request);
		}

		if (url.pathname === '/history') {
			const conv = this.conversation ?? await this.state.storage.get<SmsConversationState>('conversation');
			return Response.json({ conversation: conv ?? null });
		}

		return Response.json({ error: 'not found' }, { status: 404 });
	}

	private async handleInbound(request: Request): Promise<Response> {
		const body: any = await request.json();
		const text = body.text ?? '';
		const from = body.from ?? '';

		await this.ensureConversation(from);

		this.conversation!.messages.push({ role: 'user', text, timestamp: Date.now() });
		this.conversation!.lastMessageAt = Date.now();
		await this.state.storage.put('conversation', this.conversation!);

		return Response.json({ ok: true, messageCount: this.conversation!.messages.length });
	}

	private async handleOutbound(request: Request): Promise<Response> {
		const body: any = await request.json();
		const text: string = body.text;
		const to: string = body.to;
		const from: string = body.from ?? this.env.TELNYX_PHONE_NUMBER;
		const mediaUrls: string[] | undefined = body.mediaUrls;

		const telnyx = new TelnyxService(this.env.TELNYX_API_KEY, this.env.TELNYX_CONNECTION_ID);
		const result = await telnyx.sendSms(to, from, text, this.env.TELNYX_MESSAGING_PROFILE_ID, mediaUrls);

		await this.ensureConversation(to);
		this.conversation!.messages.push({ role: 'assistant', text, timestamp: Date.now() });
		this.conversation!.lastMessageAt = Date.now();
		await this.state.storage.put('conversation', this.conversation!);

		return Response.json({ ok: true, messageId: result.messageId });
	}

	private async ensureConversation(phoneNumber: string): Promise<void> {
		if (!this.conversation) {
			this.conversation = await this.state.storage.get<SmsConversationState>('conversation') ?? null;
		}
		if (!this.conversation) {
			this.conversation = {
				phoneNumber,
				messages: [],
				createdAt: Date.now(),
				lastMessageAt: Date.now(),
			};
		}
	}
}
