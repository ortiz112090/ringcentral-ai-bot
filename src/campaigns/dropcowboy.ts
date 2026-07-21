import { logger } from "../logger";

/**
 * Drop Cowboy ringless-voicemail (RVM) client (pure builder + one thin POST).
 *
 * Credentials (team_id/secret/brand_id) are resolved upstream via
 * resolveEffectiveConfig().dropcowboy (DB-first, env fallback primary bot only) and
 * passed in — this module never reads config or logs secrets. buildRvmPayload is
 * pure and unit-tested; sendRvm does the single HTTP call and never throws.
 */

export const DROPCOWBOY_RVM_URL = "https://api.dropcowboy.com/v1/rvm";

export interface DropCowboyCredentials {
  teamId: string | undefined;
  secret: string | undefined;
  brandId: string | undefined;
}

export interface RvmPayloadInput {
  credentials: DropCowboyCredentials;
  /** campaign_contacts.id — sent as foreign_id (String) so the webhook can map back. */
  contactId: number;
  /** Raw contact phone; normalized to E.164 digits WITHOUT '+' per their examples. */
  phoneNumber: string;
  /** campaign.dc_recording_id (Drop Cowboy recording GUID). */
  recordingId: string;
  /** bot_config.twilio_number so a callback rings the answering bot. */
  forwardingNumber: string | undefined;
  /** {PUBLIC_BASE_URL}/webhooks/dropcowboy/status?token=... */
  callbackUrl: string;
}

/** The JSON body POSTed to the Drop Cowboy RVM endpoint. */
export interface RvmPayload {
  team_id: string;
  secret: string;
  brand_id: string;
  foreign_id: string;
  phone_number: string;
  recording_id: string;
  forwarding_number?: string;
  callback_url?: string;
}

/** Digits only; drops a leading '+' and any formatting. Keeps the country code. */
export function toDigits(phone: string): string {
  return (phone ?? "").replace(/\D/g, "");
}

/**
 * Build the RVM request body. Pure — no I/O. forwarding_number/callback_url are
 * omitted when blank rather than sent empty. Credential fields default to "" so the
 * shape is stable; the worker refuses to send when team_id/secret are missing.
 */
export function buildRvmPayload(input: RvmPayloadInput): RvmPayload {
  const payload: RvmPayload = {
    team_id: input.credentials.teamId ?? "",
    secret: input.credentials.secret ?? "",
    brand_id: input.credentials.brandId ?? "",
    foreign_id: String(input.contactId),
    phone_number: toDigits(input.phoneNumber),
    recording_id: input.recordingId,
  };
  const forwarding = input.forwardingNumber?.trim();
  if (forwarding) payload.forwarding_number = forwarding;
  const callback = input.callbackUrl?.trim();
  if (callback) payload.callback_url = callback;
  return payload;
}

/** Result of one RVM POST: whether Drop Cowboy accepted it + the raw status/body. */
export interface RvmSendResult {
  ok: boolean;
  status: number;
  body: string;
}

/**
 * POST one RVM request. Never throws: a network/transport error resolves to
 * { ok:false, status:0, body:<message> } so the worker can mark the contact failed
 * and keep going. Secrets are never logged (only the numeric HTTP status).
 */
export async function sendRvm(payload: RvmPayload): Promise<RvmSendResult> {
  try {
    const res = await fetch(DROPCOWBOY_RVM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Drop Cowboy RVM request failed (transport error)", { message });
    return { ok: false, status: 0, body: message };
  }
}
