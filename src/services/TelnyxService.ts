import { logger } from '../utils/logger';

const TELNYX_API_BASE = 'https://api.telnyx.com/v2';

export class TelnyxService {
	private log = logger.child('Telnyx');
	private apiKey: string;
	private connectionId: string;

	constructor(apiKey: string, connectionId: string) {
		this.apiKey = apiKey;
		this.connectionId = connectionId;
	}

	async dial(
		to: string,
		from: string,
		webhookUrl: string,
		clientState?: string
	): Promise<{ callControlId: string; callLegId: string; callSessionId: string }> {
		const resp = await this.request('/calls', 'POST', {
			connection_id: this.connectionId,
			to,
			from,
			webhook_url: `${webhookUrl}/webhook/call`,
			webhook_url_method: 'POST',
			client_state: clientState ? btoa(clientState) : undefined,
		});

		if (!resp.ok) {
			const err = await resp.text();
			throw new Error(`Telnyx dial failed (${resp.status}): ${err}`);
		}

		const json: any = await resp.json();
		return {
			callControlId: json.data.call_control_id,
			callLegId: json.data.call_leg_id,
			callSessionId: json.data.call_session_id,
		};
	}

	async answer(callControlId: string, webhookUrl: string): Promise<void> {
		const resp = await this.request(
			`/calls/${callControlId}/actions/answer`,
			'POST',
			{ webhook_url: `${webhookUrl}/webhook/call`, webhook_url_method: 'POST' }
		);
		if (!resp.ok) {
			const err = await resp.text();
			throw new Error(`Telnyx answer failed (${resp.status}): ${err}`);
		}
	}

	async startStream(callControlId: string, streamUrl: string): Promise<void> {
		const resp = await this.request(
			`/calls/${callControlId}/actions/streaming_start`,
			'POST',
			{
				stream_url: streamUrl,
				stream_track: 'inbound_track',
				stream_bidirectional_mode: 'rtp',
				stream_bidirectional_codec: 'PCMU',
				enable_dialogflow: false,
			}
		);
		if (!resp.ok) {
			const err = await resp.text();
			throw new Error(`Telnyx streaming_start failed (${resp.status}): ${err}`);
		}
	}

	async hangup(callControlId: string): Promise<void> {
		const resp = await this.request(
			`/calls/${callControlId}/actions/hangup`,
			'POST',
			{}
		);
		if (!resp.ok) {
			this.log.warn('Hangup failed', { status: resp.status });
		}
	}

	async sendSms(
		to: string,
		from: string,
		text: string,
		messagingProfileId: string,
		mediaUrls?: string[]
	): Promise<{ messageId: string }> {
		const body: Record<string, unknown> = {
			to,
			from,
			text,
			messaging_profile_id: messagingProfileId,
		};
		if (mediaUrls?.length) {
			body.media_urls = mediaUrls;
			body.type = 'MMS';
		}
		const resp = await this.request('/messages', 'POST', body);
		if (!resp.ok) {
			const err = await resp.text();
			throw new Error(`Telnyx send SMS failed (${resp.status}): ${err}`);
		}
		const json: any = await resp.json();
		return { messageId: json.data.id };
	}

	private async request(path: string, method: string = 'GET', body?: unknown): Promise<Response> {
		return fetch(`${TELNYX_API_BASE}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				'Content-Type': 'application/json',
			},
			body: body ? JSON.stringify(body) : undefined,
		});
	}
}
