import { Router, Request, Response } from "express";
import { config } from "../config";
import { logger } from "../logger";
import { answerCall } from "../ringcentral/telephony";
import { handleCallerUtterance, onCallEnded, onCallStarted } from "../callHandler";
import { getRemoteConfig, isBotEnabled, loadRemoteConfig } from "../db/remoteConfig";
import {
  attachMediaSink,
  endCallBridge,
  MediaSink,
  pushCallerAudio,
  startCallBridge,
} from "../ringcentral/audioBridge";

/**
 * RingCentral webhook receiver.
 *
 * Two responsibilities:
 * 1. Handle the initial subscription "Validation-Token" handshake (RingCentral
 *    sends a header we must echo back to confirm the endpoint).
 * 2. Process telephony session + SMS notifications: answer new inbound calls,
 *    drive the conversation, and escalate/finalize.
 *
 * Everything is wrapped so a malformed notification can never crash the server —
 * we log and return 200 so RingCentral does not disable the subscription.
 */
/**
 * Normalize a phone number to a bare comparable digit string. Strips all
 * formatting (spaces, dashes, parens, leading "+") and a leading US country
 * code ("1") so "+1 (415) 555-0100", "14155550100" and "4155550100" all compare
 * equal. Shared by the per-tenant inbound routing filter.
 */
export function normalizePhoneNumber(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

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
 * Handle a telephony session notification. RingCentral sends the full session
 * with a `parties` array; we act on the inbound caller party's status.
 */
async function handleTelephonyEvent(sessionBody: any): Promise<void> {
  if (!sessionBody) return;
  const sessionId: string = sessionBody.telephonySessionId ?? sessionBody.sessionId;
  const parties: any[] = sessionBody.parties ?? [];

  // Refresh the Supabase-backed config so per-tenant routing (rc_main_number /
  // rc_extension) and the bot_enabled kill switch below reflect the latest
  // dashboard state on every inbound call. Fail-open on error (see loadRemoteConfig).
  await loadRemoteConfig();

  for (const party of parties) {
    const direction = party?.direction;
    const status = party?.status?.code;
    const partyId = party?.id;
    const callerNumber = party?.from?.phoneNumber ?? null;

    // Only the inbound leg into our number interests us.
    if (direction !== "Inbound") continue;

    // Per-tenant routing gate (runs BEFORE the bot_enabled kill switch, using the
    // freshly-reloaded config above). Two Render services share one RingCentral
    // account + Supabase DB, so a webhook subscription may deliver sessions that
    // belong to the *other* tenant. Only proceed for calls whose destination
    // matches THIS bot's assigned number/extension.
    //   - Both fields unset  => unassigned: fail open (preserve single-bot setups).
    //   - At least one set   => require the destination to match number OR extension.
    const botCfg = getRemoteConfig().botConfig;
    const assignedNumber = botCfg?.rc_main_number?.trim() || "";
    const assignedExtension = botCfg?.rc_extension?.trim() || "";
    if (assignedNumber || assignedExtension) {
      const destNumber = party?.to?.phoneNumber ?? null;
      // Best-effort extension match. RingCentral's telephony session party exposes
      // `to.extensionId` (the account-internal extension id); some account setups
      // omit a dialed-extension field entirely from the webhook payload. When it's
      // absent we rely on main-number matching alone (see task limitation note).
      const destExtension =
        party?.to?.extensionId != null ? String(party.to.extensionId) : null;
      const numberMatches =
        assignedNumber !== "" &&
        destNumber != null &&
        normalizePhoneNumber(destNumber) === normalizePhoneNumber(assignedNumber);
      const extensionMatches =
        assignedExtension !== "" &&
        destExtension != null &&
        destExtension === assignedExtension;
      if (!numberMatches && !extensionMatches) {
        // Belongs to a different tenant/service — skip entirely: do not answer,
        // do not escalate. RingCentral may occasionally deliver out-of-filter events.
        logger.info("Inbound call not for this tenant's assignment; skipping", {
          sessionId,
          destNumber,
          destExtension,
        });
        continue;
      }
    }

    if (status === "Setup" || status === "Proceeding") {
      // Kill switch: when bot_config.bot_enabled is explicitly false, don't answer —
      // let the call ring through to RingCentral's default handling. Fail-open if
      // Supabase config is unavailable (see isBotEnabled).
      if (!isBotEnabled()) {
        logger.info("Bot disabled; inbound call not answered", { sessionId, callerNumber });
        continue;
      }
      // New inbound call — answer it and open the GPT-4o Realtime speech-to-speech
      // bridge. The bridge creates call state + the DB record and streams audio both
      // ways for the life of the call (see src/ringcentral/audioBridge.ts).
      await answerCall(sessionId, partyId);
      await startCallBridge(sessionId, partyId, callerNumber);
      logger.info("Inbound call answered (realtime bridge)", { sessionId, callerNumber });
    } else if (status === "Disconnected") {
      endCallBridge(sessionId);
      await onCallEnded(sessionId);
      logger.info("Call disconnected", { sessionId });
    }
  }
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
