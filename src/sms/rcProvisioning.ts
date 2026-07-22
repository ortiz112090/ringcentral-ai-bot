import { config, resolveEffectiveConfig, ringcentralSmsWebhookUrl } from "../config";
import { logger } from "../logger";
import { BOT_ID } from "../db/remoteConfig";
import { rcGet, rcPost } from "../ringcentral/client";
import { roleAllows } from "../roles";

/**
 * RingCentral SMS webhook subscription auto-provisioning + slow renewal poller.
 *
 * Mirrors the never-throw, opt-in style of src/twilio/provisioning.ts: on startup we
 * ensure a message-store SMS webhook subscription exists that points RingCentral at
 * this service's /webhooks/ringcentral/sms endpoint, and an hourly poller renews it
 * before the 7-day expiry lapses. Every path is wrapped so a slow/down RC API can
 * never crash startup or the tick.
 *
 * Gated (all read fresh so a dashboard change applies with no redeploy): this tenant
 * must (a) be in the texting role, (b) have rc_sms_number set, and (c) have a
 * configured RC_SMS_WEBHOOK_TOKEN (needed to secure the delivered events). Missing
 * any of these is a benign skip, not an error.
 */

const SUBSCRIPTION_BASE = "/restapi/v1.0/subscription";

// The message-store instant SMS event filter (extension-scoped ~ = the JWT's own
// extension). Matches the inbound SMS events our webhook handler parses.
const SMS_EVENT_FILTER =
  "/restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS";

// RingCentral requires periodic renewal; max is 604800s (7 days). We request one
// second under the cap, matching the spec.
const EXPIRES_IN = 604799;

// Renew when the subscription has less than this long left before it expires.
const RENEW_LEAD_MS = 24 * 60 * 60 * 1000; // 24h

// Hourly slow poller for renewal.
const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1h

let pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * True when two webhook delivery addresses point at the same service endpoint (same
 * host + path); query string / protocol differences are ignored. Falls back to exact
 * string equality when either value isn't a parseable URL.
 */
function sameWebhookTarget(candidate: unknown, ours: string): boolean {
  if (typeof candidate !== "string" || candidate === "") return false;
  try {
    const a = new URL(candidate);
    const b = new URL(ours);
    return a.host === b.host && a.pathname === b.pathname;
  } catch {
    return candidate === ours;
  }
}

/** Whether the SMS gates (role + rc_sms_number + token) are satisfied for this tenant. */
async function smsProvisioningGate(): Promise<
  { ok: true; address: string } | { ok: false }
> {
  const address = ringcentralSmsWebhookUrl();
  if (!address) {
    logger.warn("Skipping RC SMS provisioning: PUBLIC_BASE_URL unset (no webhook URL)");
    return { ok: false };
  }
  if (config.rcSmsWebhookToken.trim() === "") {
    logger.warn("Skipping RC SMS provisioning: RC_SMS_WEBHOOK_TOKEN unset (cannot secure webhook)");
    return { ok: false };
  }
  const { text, botRole } = await resolveEffectiveConfig();
  if (!roleAllows(botRole, "sms")) {
    logger.info("Skipping RC SMS provisioning: tenant role does not allow SMS", {
      botId: BOT_ID,
      botRole,
    });
    return { ok: false };
  }
  if (!text.rcSmsNumber || text.rcSmsNumber.trim() === "") {
    // RC texting is opt-in — an unassigned rc_sms_number is expected, not an error.
    logger.info("Skipping RC SMS provisioning: no rc_sms_number assigned for this tenant", {
      botId: BOT_ID,
    });
    return { ok: false };
  }
  return { ok: true, address };
}

/** Find our existing SMS webhook subscription (by matching delivery address), or null. */
async function findOurSubscription(address: string): Promise<any | null> {
  const res = await rcGet(SUBSCRIPTION_BASE);
  const records: any[] = Array.isArray(res?.records) ? res.records : [];
  return (
    records.find(
      (sub) =>
        sub?.deliveryMode?.transportType === "WebHook" &&
        sameWebhookTarget(sub?.deliveryMode?.address, address)
    ) ?? null
  );
}

/** Create the SMS webhook subscription pointing RC at our endpoint. */
async function createSubscription(address: string): Promise<void> {
  const result = await rcPost(SUBSCRIPTION_BASE, {
    eventFilters: [SMS_EVENT_FILTER],
    deliveryMode: {
      transportType: "WebHook",
      address,
      verificationToken: config.rcSmsWebhookToken.trim(),
    },
    expiresIn: EXPIRES_IN,
  });
  logger.info("RingCentral SMS webhook subscription created", {
    botId: BOT_ID,
    id: result?.id,
    address,
    expirationTime: result?.expirationTime,
  });
}

/** Renew an existing subscription by id. */
async function renewSubscription(subscriptionId: string): Promise<void> {
  const result = await rcPost(`${SUBSCRIPTION_BASE}/${subscriptionId}/renew`, {});
  logger.info("RingCentral SMS webhook subscription renewed", {
    botId: BOT_ID,
    id: result?.id ?? subscriptionId,
    expirationTime: result?.expirationTime,
  });
}

/** True when the subscription expires within RENEW_LEAD_MS (or has no parseable expiry). */
function isExpiringSoon(expirationTime: unknown, now = Date.now()): boolean {
  if (typeof expirationTime !== "string" || expirationTime === "") return true;
  const expiresAtMs = new Date(expirationTime).getTime();
  if (Number.isNaN(expiresAtMs)) return true;
  return expiresAtMs - now < RENEW_LEAD_MS;
}

/**
 * Idempotently ensure this tenant's RC SMS webhook subscription exists and is not
 * about to expire. Exists + healthy → no-op. Exists + expiring within 24h → renew.
 * Missing → create. Never throws — any failure is logged and swallowed so startup
 * and the poller stay non-fatal.
 */
export async function provisionRcSmsSubscription(): Promise<void> {
  try {
    const gate = await smsProvisioningGate();
    if (!gate.ok) return;

    const existing = await findOurSubscription(gate.address);
    if (!existing) {
      await createSubscription(gate.address);
      return;
    }

    if (isExpiringSoon(existing.expirationTime)) {
      logger.info("RingCentral SMS webhook subscription expiring soon; renewing", {
        botId: BOT_ID,
        id: existing.id,
        expirationTime: existing.expirationTime,
      });
      try {
        await renewSubscription(String(existing.id));
      } catch (err) {
        // Renew failed (e.g. subscription vanished/blacklisted): recreate fresh.
        logger.error("RC SMS subscription renewal failed; recreating", {
          botId: BOT_ID,
          id: existing.id,
          error: err instanceof Error ? err.message : String(err),
        });
        await createSubscription(gate.address);
      }
      return;
    }

    logger.info("RingCentral SMS webhook subscription already active (no action)", {
      botId: BOT_ID,
      id: existing.id,
      expirationTime: existing.expirationTime,
    });
  } catch (err) {
    // Never fatal: a slow/down RC API must not crash startup or the poller.
    logger.error("RC SMS subscription provisioning failed (service still running)", {
      botId: BOT_ID,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Provision the RC SMS subscription once at startup, then start an hourly poller that
 * renews it before expiry. The interval is unref'd so it never keeps the process
 * alive during shutdown. Wired from src/index.ts. Safe to call once.
 */
export function startRcSmsProvisioning(): void {
  void provisionRcSmsSubscription();
  if (pollTimer) return; // never stack pollers
  pollTimer = setInterval(() => {
    void provisionRcSmsSubscription();
  }, POLL_INTERVAL_MS);
  pollTimer.unref();
}

/** Test-only: stop the poller so a test process exits cleanly. */
export function __stopRcSmsProvisioningForTests(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
