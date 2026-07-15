import { Router, Request, Response } from "express";
import { config } from "../config";
import { logger } from "../logger";
import { answerCall } from "../ringcentral/telephony";
import {
  escalateCall,
  handleCallerUtterance,
  onCallEnded,
  onCallStarted,
} from "../callHandler";
import { transcribeAudio } from "../speech/openai";

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
      // New inbound call — answer it and initialize conversation state.
      await answerCall(sessionId, partyId);
      await onCallStarted(sessionId, callerNumber);
      logger.info("Inbound call answered", { sessionId, callerNumber });
    } else if (status === "Disconnected") {
      await onCallEnded(sessionId);
      logger.info("Call disconnected", { sessionId });
    }
  }
}

/**
 * Optional text-based version of the script over SMS (stretch goal). Runs the same
 * Claude conversation engine but skips STT/TTS — inbound SMS text goes straight in,
 * and the bot's reply is sent back as an SMS.
 */
async function handleSmsEvent(messageBody: any): Promise<void> {
  if (!messageBody || messageBody.direction !== "Inbound") return;
  const from: string | undefined = messageBody.from?.phoneNumber;
  const text: string | undefined = messageBody.subject; // SMS body lives in `subject`.
  if (!from || !text) return;

  logger.info("Inbound SMS received", { from });
  // Reuse the call pipeline keyed by phone number as a pseudo call id.
  const smsCallId = `sms:${from}`;
  await onCallStarted(smsCallId, from);
  const result = await handleCallerUtterance(smsCallId, text);
  // Sending the reply SMS is left to the telephony.sendSms helper; number wiring
  // (which of the account's numbers to send from) is account-specific.
  logger.info("SMS bot reply ready", { from, reply: result.text });
}

/**
 * Exposed for the media pipeline: when caller audio has been captured for a turn,
 * transcribe it, run the conversation, and hand back the synthesized reply +
 * whether to transfer. The RingCentral media layer calls this per utterance.
 */
export async function processCallerAudio(
  sessionId: string,
  partyId: string,
  audio: Buffer
): Promise<{ audio: Buffer | null; text: string }> {
  const callerText = await transcribeAudio(audio);
  if (!callerText) {
    return { audio: null, text: "" };
  }
  const result = await handleCallerUtterance(sessionId, callerText);
  if (result.shouldTransfer) {
    await escalateCall(sessionId, sessionId, partyId);
  }
  return { audio: result.audio, text: result.text };
}
