import type { Env, TelnyxApplication, TelnyxMessagingProfile } from "./types";

const TELNYX_API_BASE = "https://api.telnyx.com/v2";

/** Make an authenticated request to the Telnyx API */
async function telnyxRequest(
  env: Env,
  path: string,
  method: string = "GET",
  body?: unknown
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.TELNYX_API_TOKEN}`,
    "Content-Type": "application/json",
  };
  return fetch(`${TELNYX_API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ── Call Control ──

/** Dial an outbound call */
export async function dialCall(
  env: Env,
  to: string,
  from: string,
  connectionId: string,
  webhookUrl: string,
  clientState?: string
): Promise<{ callControlId: string; callLegId: string; callSessionId: string }> {
  const resp = await telnyxRequest(env, "/calls", "POST", {
    connection_id: connectionId,
    to,
    from,
    webhook_url: webhookUrl,
    webhook_url_method: "POST",
    stream_url: `${webhookUrl.replace(/^http/, "ws")}/ws/call-stream`,
    stream_track: "both_tracks",
    client_state: clientState
      ? btoa(clientState)
      : undefined,
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

/** Answer an incoming call */
export async function answerCall(
  env: Env,
  callControlId: string,
  webhookUrl: string
): Promise<void> {
  const resp = await telnyxRequest(
    env,
    `/calls/${callControlId}/actions/answer`,
    "POST",
    {
      webhook_url: webhookUrl,
      webhook_url_method: "POST",
    }
  );
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Telnyx answer failed (${resp.status}): ${err}`);
  }
}

/** Start media streaming on a call */
export async function startStream(
  env: Env,
  callControlId: string,
  streamUrl: string
): Promise<void> {
  const resp = await telnyxRequest(
    env,
    `/calls/${callControlId}/actions/streaming_start`,
    "POST",
    {
      stream_url: streamUrl,
      stream_track: "inbound_track",
      stream_bidirectional_mode: "rtp",
      stream_bidirectional_codec: "L16",
      enable_dialogflow: false,
    }
  );
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Telnyx streaming_start failed (${resp.status}): ${err}`);
  }
}

/** Stop media streaming on a call */
export async function stopStream(
  env: Env,
  callControlId: string
): Promise<void> {
  const resp = await telnyxRequest(
    env,
    `/calls/${callControlId}/actions/streaming_stop`,
    "POST",
    {}
  );
  if (!resp.ok) {
    console.warn(`Telnyx streaming_stop failed: ${resp.status}`);
  }
}

/** Hang up a call */
export async function hangupCall(
  env: Env,
  callControlId: string
): Promise<void> {
  const resp = await telnyxRequest(
    env,
    `/calls/${callControlId}/actions/hangup`,
    "POST",
    {}
  );
  if (!resp.ok) {
    console.warn(`Telnyx hangup failed: ${resp.status}`);
  }
}

// ── SMS / MMS ──

/** Send an SMS or MMS message */
export async function sendSms(
  env: Env,
  to: string,
  from: string,
  text: string,
  mediaUrls?: string[]
): Promise<{ messageId: string }> {
  const body: Record<string, unknown> = {
    to,
    from,
    text,
    messaging_profile_id: env.TELNYX_MESSAGING_PROFILE_ID,
  };
  if (mediaUrls?.length) {
    body.media_urls = mediaUrls;
    body.type = "MMS";
  }
  const resp = await telnyxRequest(env, "/messages", "POST", body);
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Telnyx send SMS failed (${resp.status}): ${err}`);
  }
  const json: any = await resp.json();
  return { messageId: json.data.id };
}

// ── Provisioning: Application & Messaging Profile ──

/** Create a Telnyx call control application */
export async function createApplication(
  env: Env,
  name: string,
  webhookUrl: string
): Promise<TelnyxApplication> {
  const resp = await telnyxRequest(env, "/call_control_applications", "POST", {
    application_name: name,
    webhook_event_url: `${webhookUrl}/webhook/call`,
    webhook_event_failover_url: "",
    active: true,
    inbound: { channel_limit: 10 },
    outbound: { channel_limit: 10 },
    first_command_timeout: true,
    first_command_timeout_secs: 30,
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Telnyx create application failed (${resp.status}): ${err}`);
  }
  const json: any = await resp.json();
  return json.data as TelnyxApplication;
}

/** List existing call control applications */
export async function listApplications(env: Env): Promise<TelnyxApplication[]> {
  const resp = await telnyxRequest(env, "/call_control_applications");
  if (!resp.ok) {
    throw new Error(`Telnyx list applications failed: ${resp.status}`);
  }
  const json: any = await resp.json();
  return json.data as TelnyxApplication[];
}

/** Create a Telnyx messaging profile */
export async function createMessagingProfile(
  env: Env,
  name: string,
  webhookUrl: string
): Promise<TelnyxMessagingProfile> {
  const resp = await telnyxRequest(env, "/messaging_profiles", "POST", {
    name,
    enabled: true,
    webhook_url: `${webhookUrl}/webhook/sms`,
    webhook_failover_url: "",
    whitelisted_destinations: ["US", "CA"],
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(
      `Telnyx create messaging profile failed (${resp.status}): ${err}`
    );
  }
  const json: any = await resp.json();
  return json.data as TelnyxMessagingProfile;
}

/** List existing messaging profiles */
export async function listMessagingProfiles(
  env: Env
): Promise<TelnyxMessagingProfile[]> {
  const resp = await telnyxRequest(env, "/messaging_profiles");
  if (!resp.ok) {
    throw new Error(`Telnyx list messaging profiles failed: ${resp.status}`);
  }
  const json: any = await resp.json();
  return json.data as TelnyxMessagingProfile[];
}

/** Ensure a call control application exists, create if not */
export async function ensureApplication(
  env: Env,
  appName: string,
  webhookUrl: string
): Promise<TelnyxApplication> {
  const apps = await listApplications(env);
  const existing = apps.find((a) => a.application_name === appName);
  if (existing) return existing;
  return createApplication(env, appName, webhookUrl);
}

/** Ensure a messaging profile exists, create if not */
export async function ensureMessagingProfile(
  env: Env,
  profileName: string,
  webhookUrl: string
): Promise<TelnyxMessagingProfile> {
  const profiles = await listMessagingProfiles(env);
  const existing = profiles.find((p) => p.name === profileName);
  if (existing) return existing;
  return createMessagingProfile(env, profileName, webhookUrl);
}
