import { config, resolveEffectiveConfig } from "../config";
import { logger } from "../logger";
import { rcGet, rcPost, rcDelete } from "./client";
import { getRemoteConfig } from "../db/remoteConfig";

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

// Account-level subscription collection (not scoped under /account/~).
const SUBSCRIPTION_BASE = "/restapi/v1.0/subscription";

// Renewal timing knobs. We renew well before the 7-day expiry so a webhook never
// silently dies. Floor guards against a tight loop if expirationTime is oddly near.
const RENEW_FLOOR_MS = 5 * 60 * 1000; // 5 minutes
const RENEW_LEAD_MS = 24 * 60 * 60 * 1000; // renew at least 24h before expiry

// Matches an account-wide telephony filter — `/account/<anything>/telephony/sessions`
// where the account segment is followed DIRECTLY by /telephony (i.e. NOT an
// extension-scoped `/account/~/extension/{id}/telephony/sessions`). These are the
// dangerous leftovers from the old account-wide subscription code.
const ACCOUNT_WIDE_TELEPHONY_RE = /\/account\/[^/]+\/telephony\/sessions/;

// Single module-level renewal timer so repeated ensureWebhookSubscription() calls
// never stack multiple renew loops.
let renewalTimer: ReturnType<typeof setTimeout> | null = null;

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
 * Resolve a dialable extension number (e.g. "957") to its RingCentral internal
 * numeric extension id, which is what extension-scoped API paths require. Returns
 * null when no enabled extension matches. Never logs secret values.
 */
async function resolveExtensionId(extensionNumber: string): Promise<string | null> {
  const wanted = extensionNumber.trim();
  if (!wanted) return null;
  const res = await rcGet(`${ACCOUNT}/extension?status=Enabled&perPage=1000`);
  const records: any[] = res?.records ?? [];
  const match = records.find(
    (r) => String(r?.extensionNumber ?? "").trim() === wanted
  );
  return match?.id != null ? String(match.id) : null;
}

/**
 * True when two webhook delivery addresses point at the same service endpoint
 * (same host + path). Query string / protocol differences are ignored so a
 * re-registration of our own endpoint is still recognized as ours. Falls back to
 * exact string equality if either value isn't a parseable URL.
 */
function sameWebhookTarget(candidate: string | undefined, ours: string): boolean {
  if (!candidate) return false;
  try {
    const a = new URL(candidate);
    const b = new URL(ours);
    return a.host === b.host && a.pathname === b.pathname;
  } catch {
    return candidate === ours;
  }
}

/**
 * Self-healing startup cleanup. Lists every subscription on the account and
 * deletes the ones that are stale or dangerous, so a blacklisted or leftover
 * account-wide registration can't keep failing (RingCentral blacklists endpoints
 * after repeated delivery failures) or route other numbers' calls to us.
 *
 * A subscription is deleted ONLY if it matches at least one of:
 *   (a) status "Blacklisted", OR
 *   (b) a WebHook whose delivery address is THIS service's webhook endpoint
 *       (our own stale prior registration), OR
 *   (c) its eventFilters include an account-wide `/telephony/sessions` filter
 *       (a dangerous leftover from the old account-wide code).
 *
 * Everything else is left untouched — e.g. a healthy Active subscription scoped
 * to a different extension with a different delivery address may legitimately
 * belong to another bot tenant on this same RingCentral account.
 *
 * Each delete is isolated in its own try/catch so one failure never blocks the
 * rest, and a failure to LIST is non-fatal (we log and proceed to create fresh).
 */
async function cleanupStaleSubscriptions(deliveryAddress: string): Promise<void> {
  let records: any[] = [];
  try {
    const res = await rcGet(SUBSCRIPTION_BASE);
    records = Array.isArray(res?.records) ? res.records : [];
  } catch (err) {
    logger.error("Failed to list subscriptions for cleanup; proceeding to create fresh one", {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  for (const sub of records) {
    const status = sub?.status;
    const transportType = sub?.deliveryMode?.transportType;
    const address = sub?.deliveryMode?.address;
    const eventFilters: string[] = Array.isArray(sub?.eventFilters) ? sub.eventFilters : [];

    const isBlacklisted = status === "Blacklisted";
    const isOurs = transportType === "WebHook" && sameWebhookTarget(address, deliveryAddress);
    const isAccountWideTelephony = eventFilters.some((f) => ACCOUNT_WIDE_TELEPHONY_RE.test(f));

    if (!isBlacklisted && !isOurs && !isAccountWideTelephony) continue;

    const reason = [
      isBlacklisted ? "blacklisted" : null,
      isOurs ? "our-stale-address" : null,
      isAccountWideTelephony ? "account-wide-telephony" : null,
    ]
      .filter(Boolean)
      .join(",");

    try {
      await rcDelete(`${SUBSCRIPTION_BASE}/${sub.id}`);
      logger.info("Deleted stale/dangerous webhook subscription", {
        id: sub?.id,
        status,
        reason,
        eventFilters,
      });
    } catch (err) {
      logger.error("Failed to delete stale subscription (continuing with others)", {
        id: sub?.id,
        status,
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Schedule the next renewal well before the subscription expires. Renews at 80%
 * of the remaining lifetime OR 24h before expiry, whichever comes SOONER, with a
 * 5-minute floor so an unexpectedly-near expirationTime can't cause a tight loop.
 * The timer is unref()'d so it never keeps the process alive during shutdown, and
 * any previously-scheduled timer is cleared first (single renewal loop).
 */
function scheduleRenewal(
  subscriptionId: string,
  expirationTime: string | undefined,
  deliveryAddress: string
): void {
  if (renewalTimer) {
    clearTimeout(renewalTimer);
    renewalTimer = null;
  }
  if (!subscriptionId || !expirationTime) {
    logger.warn("Cannot schedule subscription renewal: missing id or expirationTime", {
      subscriptionId,
      expirationTime,
    });
    return;
  }
  const expiresAtMs = new Date(expirationTime).getTime();
  if (Number.isNaN(expiresAtMs)) {
    logger.warn("Cannot schedule subscription renewal: unparseable expirationTime", {
      expirationTime,
    });
    return;
  }
  const remainingMs = expiresAtMs - Date.now();
  const delayMs = Math.max(
    RENEW_FLOOR_MS,
    Math.min(remainingMs * 0.8, remainingMs - RENEW_LEAD_MS)
  );
  renewalTimer = setTimeout(() => {
    void renewSubscription(subscriptionId, deliveryAddress);
  }, delayMs);
  renewalTimer.unref();
  logger.info("Scheduled webhook subscription renewal", {
    subscriptionId,
    expirationTime,
    renewInHours: Math.round((delayMs / 3_600_000) * 10) / 10,
  });
}

/**
 * Renew an existing subscription via POST /restapi/v1.0/subscription/{id}/renew
 * (confirmed valid + non-deprecated in the RingCentral webhooks guide; a PUT to
 * /subscription/{id} is an equivalent alternative). On success we reschedule the
 * next renewal from the fresh expirationTime. On failure (e.g. the subscription
 * was deleted or blacklisted in the meantime) we fall back to the full
 * ensureWebhookSubscription flow (cleanup + recreate).
 */
async function renewSubscription(subscriptionId: string, deliveryAddress: string): Promise<void> {
  try {
    const result = await rcPost(`${SUBSCRIPTION_BASE}/${subscriptionId}/renew`, {});
    logger.info("Renewed webhook subscription", {
      subscriptionId,
      expirationTime: result?.expirationTime,
    });
    scheduleRenewal(result?.id ?? subscriptionId, result?.expirationTime, deliveryAddress);
  } catch (err) {
    logger.error("Subscription renewal failed; recreating (cleanup + create)", {
      subscriptionId,
      error: err instanceof Error ? err.message : String(err),
    });
    await ensureWebhookSubscription(deliveryAddress);
  }
}

/**
 * Create (or refresh) the RingCentral webhook subscription that pushes inbound
 * telephony + SMS events to this service's /webhooks/ringcentral endpoint.
 * Call once on startup after the public URL is known.
 *
 * Order: (1) clean up stale/dangerous subscriptions on the account, then (2)
 * create the fresh extension-scoped subscription, then (3) schedule renewal.
 *
 * SAFETY (production incident fix): the subscription is scoped to THIS tenant's
 * assigned extension so the bot only receives events for its own number — an
 * account-wide subscription previously caused the bot to answer calls across the
 * entire account. If this tenant has no `rc_extension` assigned we create NO
 * telephony subscription at all (and skip SMS too) rather than falling back to an
 * account-wide filter. The runtime routing gate in webhooks.ts is the second,
 * fail-closed line of defense.
 */
export async function ensureWebhookSubscription(deliveryAddress: string): Promise<void> {
  try {
    // Self-healing: purge blacklisted / our own stale / dangerous account-wide
    // subscriptions first, regardless of assignment, so leftovers can't linger.
    await cleanupStaleSubscriptions(deliveryAddress);

    const rcExtension = (getRemoteConfig().botConfig?.rc_extension ?? "").trim();
    if (!rcExtension) {
      logger.warn(
        "No rc_extension assigned for this tenant; skipping webhook subscription entirely " +
          "(refusing account-wide fallback to avoid receiving other numbers' calls/SMS)"
      );
      return;
    }

    const extensionId = await resolveExtensionId(rcExtension);
    if (!extensionId) {
      logger.error(
        "Could not resolve rc_extension to a RingCentral extension id; skipping webhook " +
          "subscription (refusing account-wide fallback)",
        { rcExtension }
      );
      return;
    }

    const body = {
      eventFilters: [
        `/restapi/v1.0/account/~/extension/${extensionId}/telephony/sessions`,
        `/restapi/v1.0/account/~/extension/${extensionId}/message-store/instant?type=SMS`,
      ],
      deliveryMode: {
        transportType: "WebHook",
        address: deliveryAddress,
        ...(config.ringcentral.webhookVerificationToken
          ? { validationToken: config.ringcentral.webhookVerificationToken }
          : {}),
      },
      expiresIn: 604800, // 7 days; RingCentral requires periodic renewal.
    };
    const result = await rcPost(SUBSCRIPTION_BASE, body);
    logger.info("Webhook subscription active (extension-scoped)", {
      id: result.id,
      address: deliveryAddress,
      extensionId,
      expirationTime: result.expirationTime,
    });
    scheduleRenewal(result.id, result.expirationTime, deliveryAddress);
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
