import { Router, Request, Response } from "express";
import { config, resolveEffectiveConfig } from "../config";
import { logger } from "../logger";
import { answerCall, transferToHuman } from "../ringcentral/telephony";
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
 * Decide whether an inbound call's destination belongs to THIS tenant, based on
 * the dashboard-assigned `bot_config.rc_main_number` / `rc_extension`.
 *
 * Fail-open: if this tenant has neither a main number nor an extension configured,
 * we can't route by destination, so we accept the call (preserves legacy
 * single-number deployments). If at least one is set, the call must match it.
 *
 * Extension matching is best-effort: RingCentral telephony party payloads do not
 * reliably expose the dialed extension on the `to` party, so when no extension
 * field is present on the destination we fall back to main-number matching only.
 */
function callDestinationMatchesTenant(party: any): boolean {
  const botConfig = getRemoteConfig().botConfig;
  const configuredNumber = normalizePhoneNumber(botConfig?.rc_main_number);
  const configuredExtension = (botConfig?.rc_extension ?? "").trim();

  // Fail-open: nothing configured to route on.
  if (!configuredNumber && !configuredExtension) return true;

  const destNumber = normalizePhoneNumber(party?.to?.phoneNumber);
  // Best-effort: `extensionNumber` may be absent on the `to` party; when it is,
  // destExtension is "" and extension matching is skipped in favor of the number.
  const destExtension = (party?.to?.extensionNumber ?? "").toString().trim();

  if (configuredNumber && destNumber && destNumber === configuredNumber) {
    return true;
  }
  if (configuredExtension && destExtension && destExtension === configuredExtension) {
    return true;
  }
  return false;
}

/**
 * Handle a telephony session notification. RingCentral sends the full session
 * with a `parties` array; we act on the inbound caller party's status.
 */
async function handleTelephonyEvent(sessionBody: any): Promise<void> {
  if (!sessionBody) return;
  const sessionId: string = sessionBody.telephonySessionId ?? sessionBody.sessionId;
  const parties: any[] = sessionBody.parties ?? [];

  for (const party of parties) {
    const direction = party?.direction;
    const status = party?.status?.code;
    const partyId = party?.id;
    const callerNumber = party?.from?.phoneNumber ?? null;

    // Only the inbound leg into our number interests us.
    if (direction !== "Inbound") continue;

    if (status === "Setup" || status === "Proceeding") {
      // Refresh this tenant's config fresh per call so dashboard edits (newly
      // compiled script, bot_enabled/active toggles, updated credentials) take
      // effect on the very next call without a redeploy. Non-fatal on failure —
      // loadRemoteConfig keeps the last-known-good cache and isBotEnabled fails open.
      await loadRemoteConfig();

      // Tenant number/extension routing: this bot subscription may receive calls
      // for numbers that belong to a different tenant. Using the just-reloaded
      // config, only proceed when the call's destination matches this tenant's
      // assigned rc_main_number/rc_extension. Fail-open when neither is set.
      if (!callDestinationMatchesTenant(party)) {
        logger.info("Inbound call destination not assigned to this tenant; skipping", {
          sessionId,
          callerNumber,
          toNumber: party?.to?.phoneNumber ?? null,
          toExtension: party?.to?.extensionNumber ?? null,
        });
        continue;
      }

      // Kill switch: disabled when the tenant's bots row is missing/inactive or
      // bot_config.bot_enabled is false (see isBotEnabled). When disabled, hand the
      // call to the escalation queue if one is configured; otherwise ring through.
      if (!isBotEnabled()) {
        const { escalationExtension } = await resolveEffectiveConfig();
        if (escalationExtension) {
          logger.info("Bot disabled; escalating inbound call to human queue", {
            sessionId,
            callerNumber,
            extension: escalationExtension,
          });
          try {
            await answerCall(sessionId, partyId);
            await transferToHuman(sessionId, partyId, escalationExtension);
          } catch (err) {
            logger.error("Failed to escalate disabled-bot call; letting it ring through", {
              sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        } else {
          logger.info("Bot disabled and no escalation extension; inbound call not answered", {
            sessionId,
            callerNumber,
          });
        }
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
  // Refresh tenant config so the kill switch reflects the latest dashboard state.
  await loadRemoteConfig();
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
