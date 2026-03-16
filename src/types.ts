/** Environment bindings for the Worker */
export interface Env {
  CALL_SESSION: DurableObjectNamespace;
  SMS_SESSION: DurableObjectNamespace;
  TELNYX_API_KEY: string;
  GEMINI_API_KEY: string;
  TELNYX_CONNECTION_ID: string;
  TELNYX_MESSAGING_PROFILE_ID: string;
  TELNYX_PHONE_NUMBER: string;
}

/** Telnyx webhook event wrapper */
export interface TelnyxWebhookEvent {
  data: {
    event_type: string;
    id: string;
    occurred_at: string;
    payload: TelnyxCallPayload | TelnyxSmsPayload;
    record_type: string;
  };
  meta: {
    attempt: number;
    delivered_to: string;
  };
}

/** Telnyx call control payload */
export interface TelnyxCallPayload {
  call_control_id: string;
  call_leg_id: string;
  call_session_id: string;
  client_state?: string;
  connection_id: string;
  direction: "incoming" | "outgoing";
  from: string;
  to: string;
  state: string;
  stream_url?: string;
  // Media streaming fields
  media?: {
    track: "inbound" | "outbound" | "both";
    payload: string; // base64 encoded audio
    chunk?: string;
  };
}

/** Telnyx SMS/MMS payload */
export interface TelnyxSmsPayload {
  id: string;
  direction: "inbound" | "outbound";
  from: { phone_number: string; carrier?: string; line_type?: string };
  to: { phone_number: string }[] | { phone_number: string };
  text: string;
  type: "SMS" | "MMS";
  messaging_profile_id: string;
  media?: { url: string; content_type: string }[];
}

/** Request to initiate an outbound call */
export interface OutboundCallRequest {
  to: string;          // E.164 phone number
  from?: string;       // Override caller ID
  systemPrompt?: string;
  firstMessage?: string;
}

/** Request to send an SMS */
export interface OutboundSmsRequest {
  to: string;
  text: string;
  from?: string;
  mediaUrls?: string[];
}

/** Telnyx TeXML/call control application */
export interface TelnyxApplication {
  id: string;
  record_type: string;
  application_name: string;
  webhook_event_url: string;
  webhook_event_failover_url: string;
  active: boolean;
  inbound?: { channel_limit?: number; sip_subdomain?: string };
  outbound?: { channel_limit?: number; outbound_voice_profile_id?: string };
}

/** Telnyx messaging profile */
export interface TelnyxMessagingProfile {
  id: string;
  record_type: string;
  name: string;
  enabled: boolean;
  webhook_url: string;
  webhook_failover_url: string;
}

/** Gemini Audio Live session config */
export interface GeminiSessionConfig {
  model: string;
  generationConfig: {
    responseModalities: string[];
    speechConfig?: {
      voiceConfig?: {
        prebuiltVoiceConfig?: { voiceName: string };
      };
    };
  };
  systemInstruction?: {
    parts: { text: string }[];
  };
}

/** Messages sent over the Gemini Audio Live WebSocket */
export interface GeminiRealtimeInput {
  realtimeInput: {
    mediaChunks: { mimeType: string; data: string }[];
  };
}

export interface GeminiClientContent {
  clientContent: {
    turns: { role: string; parts: { text: string }[] }[];
    turnComplete: boolean;
  };
}

export interface GeminiSetup {
  setup: GeminiSessionConfig;
}

export type GeminiClientMessage = GeminiRealtimeInput | GeminiClientContent | GeminiSetup;

/** Internal call state stored in Durable Object */
export interface CallState {
  callControlId?: string;
  callSessionId?: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  status: "initiating" | "ringing" | "answered" | "streaming" | "ended";
  startedAt: number;
  endedAt?: number;
  systemPrompt?: string;
}

/** Internal SMS conversation state */
export interface SmsConversationState {
  phoneNumber: string;
  messages: { role: "user" | "assistant"; text: string; timestamp: number }[];
  createdAt: number;
  lastMessageAt: number;
}
