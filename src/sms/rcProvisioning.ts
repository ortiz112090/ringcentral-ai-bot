import { config, resolveEffectiveConfig, ringcentralSmsWebhookUrl } from "../config";
import { logger } from "../logger";
import { BOT_ID } from "../db/remoteConfig";
import { rcGet, rcPost, rcDelete, extractRcErrorDetail } from "../ringcentral/client";
import { roleAllows } from "../roles";
import { replaceRcSmsOptions, type RcSmsOptionInput } from "./smsQueries";

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

/** Normalize a chosen extension id to a URL segment: blank/undefined → '~'. */
function extSegment(extensionId: string | undefined): string {
  return extensionId && extensionId.trim() !== "" ? extensionId.trim() : "~";
}

/**
 * The message-store instant SMS event filter for the extension the bot sends as.
 * `~` targets the JWT's own (authenticated) extension — the pre-PR-G behavior when
 * no rc_sms_extension_id is configured. Matches the inbound SMS events our webhook
 * handler parses.
 */
function smsEventFilter(extensionId: string | undefined): string {
  return `/restapi/v1.0/account/~/extension/${extSegment(extensionId)}/message-store/instant?type=SMS`;
}

/**
 * The extension a subscription's SMS event filter targets, e.g. '~' or '4056789012'.
 * Parses the `/extension/{ext}/message-store` segment; defaults to '~' when there is
 * no parseable SMS message-store filter, so a legacy/opaque subscription isn't
 * needlessly recreated when the bot is still on the authenticated extension.
 */
function subscriptionTargetExtension(sub: any): string {
  const filters: unknown[] = Array.isArray(sub?.eventFilters) ? sub.eventFilters : [];
  const smsFilter = filters.find(
    (f) => typeof f === "string" && f.includes("/message-store/")
  );
  if (typeof smsFilter !== "string") return "~";
  const m = smsFilter.match(/\/extension\/([^/]+)\/message-store/);
  return m ? m[1] : "~";
}

// RingCentral requires periodic renewal; max is 604800s (7 days). We request one
// second under the cap, matching the spec.
const EXPIRES_IN = 604799;

// RC's subscription-create validation POSTs our webhook a probe and requires a
// response within 3000ms. During boot / free-tier cold start the service can't
// answer in time and RC returns SUB-521 ("WebHook is not reachable"). That is
// transient, so we retry creation later at increasing delays instead of leaving
// the tenant with no subscription until the next boot. Non-blocking: each retry is
// a self-scheduling unref'd timer, so startup and the poller never wait on it.
const CREATE_RETRY_DELAYS_MS = [15_000, 45_000, 120_000];

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
  { ok: true; address: string; extensionId: string | undefined } | { ok: false }
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
  return { ok: true, address, extensionId: text.rcSmsExtensionId };
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

/**
 * Create the SMS webhook subscription pointing RC at our endpoint, targeting the
 * message-store of the extension the bot sends as (extensionId, or '~' when unset).
 */
async function createSubscription(
  address: string,
  extensionId: string | undefined
): Promise<void> {
  const result = await rcPost(SUBSCRIPTION_BASE, {
    eventFilters: [smsEventFilter(extensionId)],
    deliveryMode: {
      transportType: "WebHook",
      address,
      validationToken: config.rcSmsWebhookToken.trim(),
    },
    expiresIn: EXPIRES_IN,
  });
  logger.info("RingCentral SMS webhook subscription created", {
    botId: BOT_ID,
    id: result?.id,
    address,
    extension: extSegment(extensionId),
    expirationTime: result?.expirationTime,
  });
}

/** True when an RC error is SUB-521 ("WebHook is not reachable" validation probe). */
function isSub521(detail: Record<string, unknown> | undefined, err: unknown): boolean {
  if (detail?.errorCode === "SUB-521") return true;
  const errs = Array.isArray(detail?.errors) ? (detail!.errors as any[]) : [];
  if (errs.some((e) => e?.errorCode === "SUB-521")) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("SUB-521");
}

/**
 * True when an error looks like a transport/network failure (no HTTP response, or a
 * known connect/DNS/timeout code) rather than an RC-application error. Such failures
 * are transient and safe to retry, same as SUB-521.
 */
function isNetworkError(err: unknown): boolean {
  const status = (err as { response?: { status?: unknown } })?.response?.status;
  if (typeof status === "number") return false; // RC answered → application error, not transport
  const code = (err as { code?: unknown })?.code;
  const networkCodes = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"];
  if (typeof code === "string" && networkCodes.includes(code)) return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("timeout") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("enotfound")
  );
}

/** Delete a subscription by id, logging (never throwing) on failure. */
async function deleteStaleSubscription(id: string): Promise<void> {
  try {
    await rcDelete(`${SUBSCRIPTION_BASE}/${id}`);
  } catch (err) {
    const detail = await extractRcErrorDetail(err);
    logger.warn("Failed to delete stale RC SMS subscription", {
      botId: BOT_ID,
      id,
      error: err instanceof Error ? err.message : String(err),
      errorCode: detail?.errorCode,
      errors: detail?.errors,
    });
  }
}

/**
 * Create the subscription, and on a transient failure (SUB-521 or a network error)
 * retry later at increasing delays (CREATE_RETRY_DELAYS_MS) via self-scheduling
 * unref'd timers — non-blocking, so startup/poller never wait. On any other RC error
 * (auth, invalid param, …) the error is rethrown so the caller's top-level handler
 * logs it and does not retry.
 *
 * Safer-ordering guarantee: a replacement is only created here; the caller's stale
 * subscription (staleSubscriptionId) is deleted ONLY after this create succeeds, so
 * we never land in the "deleted the working subscription but failed to recreate" dead
 * state — even when success only happens on a later retry.
 */
async function createSubscriptionWithRetry(
  address: string,
  extensionId: string | undefined,
  staleSubscriptionId?: string,
  attempt = 0
): Promise<void> {
  try {
    await createSubscription(address, extensionId);
    if (staleSubscriptionId) {
      // Create-then-delete: the new subscription is live, so removing the old one
      // now can never leave the tenant without a working subscription.
      await deleteStaleSubscription(staleSubscriptionId);
    }
  } catch (err) {
    const detail = await extractRcErrorDetail(err);
    const retryable = isSub521(detail, err) || isNetworkError(err);
    if (retryable && attempt < CREATE_RETRY_DELAYS_MS.length) {
      const delayMs = CREATE_RETRY_DELAYS_MS[attempt];
      logger.warn("RC SMS subscription create failed (transient); scheduling retry", {
        botId: BOT_ID,
        attempt: attempt + 1,
        maxRetries: CREATE_RETRY_DELAYS_MS.length,
        delayMs,
        error: err instanceof Error ? err.message : String(err),
        errorCode: detail?.errorCode,
      });
      const timer = setTimeout(() => {
        void createSubscriptionWithRetry(address, extensionId, staleSubscriptionId, attempt + 1);
      }, delayMs);
      timer.unref?.();
      return;
    }
    if (retryable) {
      // Retries exhausted: log and stop. The old subscription (if any) was never
      // deleted, so inbound replies keep flowing; the hourly poller will try again.
      logger.error(
        "RC SMS subscription create failed after all retries (service still running)",
        {
          botId: BOT_ID,
          attempts: attempt + 1,
          error: err instanceof Error ? err.message : String(err),
          errorCode: detail?.errorCode,
          errors: detail?.errors,
        }
      );
      return;
    }
    // Non-transient error: surface to the top-level handler (no retry).
    throw err;
  }
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
      await createSubscriptionWithRetry(gate.address, gate.extensionId);
      return;
    }

    // The subscription must follow the extension the bot sends as. Only recreate on a
    // true mismatch when an EXPLICIT extension id is configured. When the desired
    // extension is '~' (the authenticated user, our default), RC persists and returns
    // the RESOLVED numeric id (e.g. "1908698019"); comparing that to the literal '~'
    // would false-positive on every boot and delete the working subscription — the
    // production self-destruct bug. Any subscription in this list already matches our
    // webhook address, so on '~' it is ours regardless of the stored numeric id.
    const desiredExt = extSegment(gate.extensionId);
    const currentExt = subscriptionTargetExtension(existing);
    if (desiredExt !== "~" && currentExt !== desiredExt) {
      logger.info("RC SMS subscription targets a different extension; recreating", {
        botId: BOT_ID,
        id: existing.id,
        currentExtension: currentExt,
        desiredExtension: desiredExt,
      });
      // Create-then-delete (Fix 3): the old subscription is removed only after the
      // replacement is confirmed created (inside createSubscriptionWithRetry), so a
      // failed/retrying create never leaves us with no subscription.
      await createSubscriptionWithRetry(gate.address, gate.extensionId, String(existing.id));
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
        const detail = await extractRcErrorDetail(err);
        logger.error("RC SMS subscription renewal failed; recreating", {
          botId: BOT_ID,
          id: existing.id,
          error: err instanceof Error ? err.message : String(err),
          errorCode: detail?.errorCode,
          errors: detail?.errors,
        });
        // Recreate with the same safe ordering + SUB-521 retry; delete the stale
        // subscription only after the replacement is live.
        await createSubscriptionWithRetry(gate.address, gate.extensionId, String(existing.id));
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
    const detail = await extractRcErrorDetail(err);
    logger.error("RC SMS subscription provisioning failed (service still running)", {
      botId: BOT_ID,
      error: err instanceof Error ? err.message : String(err),
      errorCode: detail?.errorCode,
      errors: detail?.errors,
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
  void syncRcSmsOptions();
  if (pollTimer) return; // never stack pollers
  pollTimer = setInterval(() => {
    void provisionRcSmsSubscription();
    void syncRcSmsOptions();
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

// ============================================================
// RC SMS sender OPTIONS sync (read-model for the dashboard dropdowns).
//
// Refreshes rc_sms_options from the RC account: the list of enabled User
// extensions and, per SMS-capable DirectNumber, which extension it belongs to.
// Runs hourly (piggybacking the subscription poller above) + once at startup.
// Never throws: any fetch failure is logged and the old rows are left in place
// (we only replace after a successful fetch). When the RC token lacks
// account-level read permission (403), we fall back to syncing just the
// authenticated extension so the dropdown still works single-user.
// ============================================================

const EXTENSION_LIST =
  "/restapi/v1.0/account/~/extension?perPage=1000&status=Enabled&type=User";
const ACCOUNT_PHONE_NUMBERS =
  "/restapi/v1.0/account/~/phone-number?perPage=1000&usageType=DirectNumber";
const AUTHED_EXTENSION = "/restapi/v1.0/account/~/extension/~";
const AUTHED_EXTENSION_PHONE_NUMBERS =
  "/restapi/v1.0/account/~/extension/~/phone-number?perPage=1000";

interface ExtensionInfo {
  name: string;
  number: string;
}

/** True when a phone-number's `features` array marks it able to send SMS/MMS. */
function isSmsCapable(features: unknown): boolean {
  if (!Array.isArray(features)) return false;
  return features.some((f) => f === "SmsSender" || f === "MmsSender");
}

/** A RingCentral id coerced to a trimmed string (ids may arrive as number or string). */
function idString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

/** True when a RingCentral SDK error is an HTTP 403 (missing account-level permission). */
function isForbidden(err: unknown): boolean {
  const status = (err as { response?: { status?: unknown } })?.response?.status;
  if (status === 403) return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes("403") || msg.includes("forbidden");
}

/**
 * Account-level sync: enumerate enabled User extensions, then map each SMS-capable
 * DirectNumber to its owning extension's name/number. Throws on any RC API error so
 * the caller can distinguish a 403 (→ single-extension fallback) from a preserve-old-rows failure.
 */
async function fetchAccountLevelOptions(): Promise<RcSmsOptionInput[]> {
  const extRes = await rcGet(EXTENSION_LIST);
  const extRecords: any[] = Array.isArray(extRes?.records) ? extRes.records : [];
  const extById = new Map<string, ExtensionInfo>();
  for (const e of extRecords) {
    const id = idString(e?.id);
    if (id === "") continue;
    extById.set(id, {
      name: typeof e?.name === "string" ? e.name : "",
      number: idString(e?.extensionNumber),
    });
  }

  const phoneRes = await rcGet(ACCOUNT_PHONE_NUMBERS);
  const phoneRecords: any[] = Array.isArray(phoneRes?.records) ? phoneRes.records : [];
  const options: RcSmsOptionInput[] = [];
  for (const p of phoneRecords) {
    if (!isSmsCapable(p?.features)) continue;
    const phoneNumber = typeof p?.phoneNumber === "string" ? p.phoneNumber : "";
    if (phoneNumber === "") continue;
    const extId = idString(p?.extension?.id);
    const info = extById.get(extId);
    options.push({
      extension_id: extId,
      extension_name: info?.name ?? "",
      extension_number: info?.number ?? "",
      phone_number: phoneNumber,
      sms_enabled: true,
    });
  }
  return options;
}

/**
 * Single-extension fallback (used when the account-level read is forbidden): sync
 * only the authenticated extension and its own SMS-capable numbers, so the dropdown
 * still works for a single-user app.
 */
async function fetchSingleExtensionOptions(): Promise<RcSmsOptionInput[]> {
  const ext = await rcGet(AUTHED_EXTENSION);
  const extId = idString(ext?.id);
  const name = typeof ext?.name === "string" ? ext.name : "";
  const number = idString(ext?.extensionNumber);

  const phoneRes = await rcGet(AUTHED_EXTENSION_PHONE_NUMBERS);
  const phoneRecords: any[] = Array.isArray(phoneRes?.records) ? phoneRes.records : [];
  const options: RcSmsOptionInput[] = [];
  for (const p of phoneRecords) {
    if (!isSmsCapable(p?.features)) continue;
    const phoneNumber = typeof p?.phoneNumber === "string" ? p.phoneNumber : "";
    if (phoneNumber === "") continue;
    options.push({
      extension_id: extId,
      extension_name: name,
      extension_number: number,
      phone_number: phoneNumber,
      sms_enabled: true,
    });
  }
  return options;
}

/**
 * Refresh this bot's rc_sms_options read-model from RingCentral. Never throws:
 *   - No RC credentials configured → benign skip.
 *   - Account-level read forbidden (403) → fall back to the authenticated extension
 *     only and warn (naming the missing permission).
 *   - Any other fetch failure → log and leave the existing rows in place (we only
 *     call replaceRcSmsOptions after a successful fetch).
 */
export async function syncRcSmsOptions(): Promise<void> {
  try {
    const eff = await resolveEffectiveConfig();
    const rc = eff.ringcentral;
    if (!rc?.clientId || !rc?.clientSecret || !rc?.jwt) {
      logger.info("Skipping RC SMS options sync: RingCentral credentials not configured", {
        botId: BOT_ID,
      });
      return;
    }

    let options: RcSmsOptionInput[];
    try {
      options = await fetchAccountLevelOptions();
    } catch (err) {
      if (isForbidden(err)) {
        logger.warn(
          "RC SMS options: account-level read forbidden (403). The RingCentral app " +
            "lacks the 'Read Accounts' (account-level extension/phone-number read) " +
            "permission; falling back to the authenticated extension only.",
          { botId: BOT_ID }
        );
        options = await fetchSingleExtensionOptions();
      } else {
        throw err;
      }
    }

    await replaceRcSmsOptions(options);
    logger.info("RC SMS sender options synced", { botId: BOT_ID, count: options.length });
  } catch (err) {
    // Never fatal, and never wipe: the old rows stay until a fetch succeeds.
    logger.error("RC SMS options sync failed (old rows left in place)", {
      botId: BOT_ID,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
