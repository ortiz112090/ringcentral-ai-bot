import { Router, Request, Response } from "express";
import { config } from "../config";
import { logger } from "../logger";
import { handleCallerUtterance, onCallStarted } from "../callHandler";
import { getRemoteConfig, isBotEnabled, loadRemoteConfig } from "../db/remoteConfig";
import { attachMediaSink, MediaSink, pushCallerAudio } from "../ringcentral/audioBridge";

/**
 * RingCentral webhook receiver — DORMANT for voice under the Twilio-native rebuild.
 *
 * RingCentral is retired from the voice hot path: the bot no longer creates an RC
 * webhook subscription, so RC never POSTs here in normal operation. This route
 * stays mounted (harmless if RC never calls it) but MUST NOT answer or bridge any
 * call — Twilio Media Streams drives all voice now (see src/twilio/*). The RC
 * modules are kept dormant (not deleted) for a possible future RC-native mode.
 *
 * Responsibilities that remain:
 * 1. The subscription "Validation-Token" handshake (echo the header back), so any
 *    stale/manual RC subscription can still be validated without error.
 * 2. Telephony notifications are logged and ignored (no answer/bridge).
 * 3. The optional text-only SMS script path is left intact but dormant (RC never
 *    delivers here without a subscription).
 *
 * Everything is wrapped so a malformed notification can never crash the server.
 */
export const webhookRouter = Router();

webhookRouter.post("/webhooks/ringcentral", async (req: Request, res: Response) => {
  // 1. Subscription validation handshake.
  const validationToken = req.header("Validation-Token");
  if (validationToken) {
    res.set("Validation-Token", validationToken);
    return res.status(200).send();
  }

  // 2. Optional verification-token check on delivered events.
  if (config.ringcentral.webhookVerificationToken) {
    const token = req.header("Verification-Token");
    if (token !== config.ringcentral.webhookVerificationToken) {
      logger.warn("Rejected webhook with bad verification token");
      return res.status(401).send();
    }
  }

  // Acknowledge immediately; process asynchronously so we never block RingCentral.
  res.status(200).send();

  try {
    await routeNotification(req.body);
  } catch (err) {
    logger.error("Error processing webhook notification", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

async function routeNotification(body: any): Promise<void> {
  const event: string = body?.event ?? "";

  if (event.includes("/telephony/sessions")) {
    await handleTelephonyEvent(body?.body);
  } else if (event.includes("/message-store/instant")) {
    await handleSmsEvent(body?.body);
  } else {
    logger.debug("Ignoring unhandled webhook event", { event });
  }
}

/**
 * Normalize a phone number for tenant-routing comparison: strip everything except
 * digits, then drop a leading US "1" country code so that "+1 (555) 010-1234",
 * "15550101234", and "5550101234" all compare equal. Returns "" for null/blank.
 */
function normalizePhoneNumber(value: string | null | undefined): string {
  if (!value) return "";
  let digits = value.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }
  return digits;
}

/**
 * SMS destination gate (fail closed). The SMS event filter may still
 * be account-wide (no reliably-scoped SMS filter), so we apply the same
 * fail-CLOSED destination gate scoped to `rc_main_number`.
 *
 * The inbound SMS payload exposes destination number(s) on `to` (array of
 * `{ phoneNumber }`). When rc_main_number is set we require one of the `to`
 * numbers to match it. If rc_main_number is not set we refuse (fail closed),
 * matching the call path. If the payload carries no usable `to` numbers we cannot
 * prove ownership, so we also refuse.
 */
function smsDestinationMatchesTenant(messageBody: any): boolean {
  const botConfig = getRemoteConfig().botConfig;
  const configuredNumber = normalizePhoneNumber(botConfig?.rc_main_number);

  if (!configuredNumber) {
    logger.warn(
      "Tenant has no rc_main_number/rc_extension assigned; refusing to process SMS to avoid handling messages for other numbers",
      { from: messageBody?.from?.phoneNumber ?? null }
    );
    return false;
  }

  const toEntries: any[] = Array.isArray(messageBody?.to) ? messageBody.to : [];
  const destNumbers = toEntries.map((t) => normalizePhoneNumber(t?.phoneNumber)).filter(Boolean);
  if (destNumbers.length === 0) {
    logger.warn("Inbound SMS has no usable destination number; refusing (fail closed)", {
      from: messageBody?.from?.phoneNumber ?? null,
    });
    return false;
  }
  return destNumbers.includes(configuredNumber);
}

/**
 * DORMANT: RingCentral telephony notifications are ignored under the Twilio-native
 * rebuild. RC no longer answers or bridges calls — Twilio Media Streams drives all
 * voice (see src/twilio/*). We only log receipt so an unexpected RC delivery (e.g.
 * a stale/manual subscription) is visible without any answer/bridge side effects.
 */
async function handleTelephonyEvent(sessionBody: any): Promise<void> {
  if (!sessionBody) return;
  const sessionId: string = sessionBody.telephonySessionId ?? sessionBody.sessionId;
  logger.info("RingCentral telephony event ignored (retired from hot path; Twilio drives voice)", {
    sessionId,
  });
}

/**
 * Optional text-based version of the script over SMS (stretch goal). Runs the OpenAI
 * chat conversation engine (getBotDecision) — inbound SMS text goes straight in, and
 * the bot's reply is sent back as an SMS. (Live voice calls use the Realtime engine.)
 */
async function handleSmsEvent(messageBody: any): Promise<void> {
  if (!messageBody || messageBody.direction !== "Inbound") return;
  const from: string | undefined = messageBody.from?.phoneNumber;
  const text: string | undefined = messageBody.subject; // SMS body lives in `subject`.
  if (!from || !text) return;

  logger.info("Inbound SMS received", { from });
  // Refresh tenant config so routing + kill switch reflect the latest dashboard state.
  await loadRemoteConfig();
  // Destination routing (fail closed): the SMS filter is account-wide, so ensure
  // the message is actually addressed to this tenant's rc_main_number before we
  // process it. An unassigned tenant refuses all SMS, mirroring the call path.
  if (!smsDestinationMatchesTenant(messageBody)) {
    return;
  }
  // Kill switch: same gate as inbound calls — skip processing when disabled.
  if (!isBotEnabled()) {
    logger.info("Bot disabled; inbound SMS not processed", { from });
    return;
  }
  // Reuse the call pipeline keyed by phone number as a pseudo call id.
  const smsCallId = `sms:${from}`;
  await onCallStarted(smsCallId, from);
  const result = await handleCallerUtterance(smsCallId, text);
  // Sending the reply SMS is left to the telephony.sendSms helper; number wiring
  // (which of the account's numbers to send from) is account-specific.
  logger.info("SMS bot reply ready", { from, reply: result.text });
}

/**
 * Media-pipeline entry points for the live Realtime voice bridge.
 *
 * The RingCentral media layer (whatever streaming transport your account exposes — see
 * the caveat in src/ringcentral/audioBridge.ts) must:
 *   1. call `onCallerAudioChunk(sessionId, base64)` for each inbound audio chunk it
 *      receives from the caller, and
 *   2. register an outbound sink via `registerBotAudioSink(sessionId, sink)` so the
 *      model's streamed audio is written back to the caller.
 * Audio is in `config.openai.realtimeAudioFormat` (default g711_ulaw); transcode at this
 * boundary if your media feed uses a different codec/sample rate.
 */
export function onCallerAudioChunk(sessionId: string, base64Audio: string): void {
  pushCallerAudio(sessionId, base64Audio);
}

export function registerBotAudioSink(sessionId: string, sink: MediaSink): void {
  attachMediaSink(sessionId, sink);
}
