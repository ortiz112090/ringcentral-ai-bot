import { config, resolveEffectiveConfig } from "../config";
import { logger } from "../logger";
import { rcGet, rcPost } from "./client";

/**
 * Thin helpers over RingCentral's Call Control (Telephony Sessions) API.
 *
 * Call Control endpoints operate on a telephonySessionId + partyId:
 *   POST /restapi/v1.0/account/~/telephony/sessions/{sessionId}/parties/{partyId}/answer
 *   POST .../parties/{partyId}/transfer
 *   POST .../parties/{partyId}/play   (media playback)
 *
 * The media plumbing (streaming caller audio to STT and pushing TTS bytes back)
 * depends on your RingCentral media package/account capabilities. The functions
 * below cover call control; playAudio documents where TTS bytes are handed off.
 */

const ACCOUNT = "/restapi/v1.0/account/~";

/** Answer an inbound call leg. */
export async function answerCall(sessionId: string, partyId: string): Promise<void> {
  try {
    await rcPost(
      `${ACCOUNT}/telephony/sessions/${sessionId}/parties/${partyId}/answer`,
      {}
    );
    logger.info("Answered call", { sessionId, partyId });
  } catch (err) {
    logger.error("Failed to answer call", {
      sessionId,
      partyId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Transfer (blind) the call to the escalation queue extension.
 * Used for both explicit escalations and as the safety fallback on any error.
 */
export async function transferToHuman(
  sessionId: string,
  partyId: string,
  extension?: string
): Promise<void> {
  // Resolve the escalation extension per-tenant (env + this bot's Supabase config)
  // when the caller doesn't supply one, rather than the raw env baseline which is
  // empty for correctly-configured non-primary tenants.
  const ext =
    extension ?? (await resolveEffectiveConfig()).escalationExtension ?? "";
  if (!ext) {
    logger.error("Cannot transfer call: no escalation extension configured for this tenant", {
      sessionId,
      partyId,
    });
    throw new Error("No escalation extension configured for this tenant");
  }
  try {
    await rcPost(
      `${ACCOUNT}/telephony/sessions/${sessionId}/parties/${partyId}/transfer`,
      { extensionNumber: ext }
    );
    logger.info("Transferred call to human queue", { sessionId, partyId, extension: ext });
  } catch (err) {
    logger.error("Failed to transfer call", {
      sessionId,
      partyId,
      extension: ext,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Play synthesized speech to the caller.
 *
 * RingCentral media playback expects a hosted media resource/URI. The TTS bytes
 * produced by src/speech/openai.ts should be exposed at a reachable URL (e.g.
 * written to a short-lived public object / this service's /media route) and that
 * URL passed here. This helper posts the play request; wire `mediaUrl` to however
 * you host the generated clip.
 */
export async function playAudio(
  sessionId: string,
  partyId: string,
  mediaUrl: string
): Promise<void> {
  try {
    await rcPost(
      `${ACCOUNT}/telephony/sessions/${sessionId}/parties/${partyId}/play`,
      { resources: [{ uri: mediaUrl }] }
    );
    logger.info("Playing audio to caller", { sessionId, partyId });
  } catch (err) {
    logger.error("Failed to play audio", {
      sessionId,
      partyId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** Send an SMS (used by the optional text-based script + soft-close contact-info texts). */
export async function sendSms(to: string, from: string, text: string): Promise<void> {
  try {
    await rcPost(`${ACCOUNT}/extension/~/sms`, {
      from: { phoneNumber: from },
      to: [{ phoneNumber: to }],
      text,
    });
    logger.info("Sent SMS", { to });
  } catch (err) {
    logger.error("Failed to send SMS", {
      to,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Create (or refresh) the RingCentral webhook subscription that pushes inbound
 * telephony + SMS events to this service's /webhooks/ringcentral endpoint.
 * Call once on startup after the public URL is known.
 */
export async function ensureWebhookSubscription(deliveryAddress: string): Promise<void> {
  try {
    const body = {
      eventFilters: [
        "/restapi/v1.0/account/~/telephony/sessions",
        "/restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS",
      ],
      deliveryMode: {
        transportType: "WebHook",
        address: deliveryAddress,
        ...(config.ringcentral.webhookVerificationToken
          ? { verificationToken: config.ringcentral.webhookVerificationToken }
          : {}),
      },
      expiresIn: 604800, // 7 days; RingCentral requires periodic renewal.
    };
    const result = await rcPost(`${ACCOUNT.replace("/account/~", "")}/subscription`, body);
    logger.info("Webhook subscription active", { id: result.id, address: deliveryAddress });
  } catch (err) {
    logger.error("Failed to create webhook subscription", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Fetch details for a telephony session (useful for recovering party ids). */
export async function getTelephonySession(sessionId: string): Promise<any> {
  return rcGet(`${ACCOUNT}/telephony/sessions/${sessionId}`);
}
