import { Router, Request, Response } from "express";
import twilio, { twiml as Twiml } from "twilio";
import {
  mediaStreamWssUrl,
  resolveEffectiveConfig,
  twilioStatusCallbackUrl,
  twilioVoiceWebhookUrl,
} from "../config";
import { logger } from "../logger";
import { BOT_ID, isBotEnabled, loadRemoteConfig } from "../db/remoteConfig";
import { getTwilioAuthToken } from "./client";
import { createStreamToken } from "./streamToken";
import { roleAllows } from "../roles";
import {
  BotActiveStatus,
  closeCallIfLive,
  createCallRecord,
  fetchBotActiveStatus,
} from "../db/queries";

/**
 * Twilio inbound-call webhook (POST /webhooks/twilio/voice) + status callback
 * (POST /webhooks/twilio/status).
 *
 * The bot is fully Twilio-native: Twilio answers every call and Media Streams
 * carries the audio (RC-owned numbers reach us via RC-side call forwarding, which
 * involves zero code here). Twilio POSTs application/x-www-form-urlencoded call
 * params to the voice webhook. We:
 *   1. Validate the X-Twilio-Signature (reject 403 on missing token / bad sig).
 *   2. Reload remote config so dashboard edits apply on the next call.
 *   3. Fail-closed decide the TwiML (see buildVoiceTwiml): honor the kill switch
 *      FIRST, then require the To number to be ours, else return graceful fallback
 *      TwiML (dial escalation or "call back later" + hangup) — never a Realtime
 *      session in those branches.
 *   4. On answer, INSERT the two-phase call row (phase 1) and <Connect><Stream>
 *      to the per-call media WebSocket (/media/{CallSid}), passing the resolved
 *      caller number and a call-bound HMAC token as custom <Parameter>s.
 */
export const twilioVoiceRouter = Router();

/** Digits-only phone comparison; drops a leading US "1". Mirrors webhooks.ts. */
function normalizePhoneNumber(value: string | null | undefined): string {
  if (!value) return "";
  let digits = value.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits;
}

/**
 * Resolve the ORIGINAL caller's number for a (possibly RC-forwarded) call.
 *
 * When RingCentral forwards its number to our Twilio number, Twilio's `From` may
 * carry the RC/forwarding number rather than the lead's real number, while the
 * original caller is exposed on `ForwardedFrom`. We therefore prefer
 * `ForwardedFrom` when it is present AND different from our own `To` number
 * (guarding against it echoing the dialed number), otherwise fall back to `From`.
 *
 * !!! VERIFY with a real RC-forwarded test call which Twilio param actually holds
 * the original caller's number (ForwardedFrom vs From vs Called); adjust the
 * preference order here if this is wrong. This cannot be confirmed without a live
 * forwarded call and is flagged in the PR as an operator-must-verify item. !!!
 */
export function resolveCallerNumber(input: {
  from: string | null;
  forwardedFrom: string | null;
  to: string | null;
}): string | null {
  const forwarded = input.forwardedFrom?.trim();
  if (
    forwarded &&
    normalizePhoneNumber(forwarded) !== normalizePhoneNumber(input.to)
  ) {
    return forwarded;
  }
  const from = input.from?.trim();
  return from ? from : null;
}

export interface VoiceDecisionInput {
  /** Twilio CallSid — bound into the media-stream token so it's call-specific. */
  callSid: string | null;
  /** Called (destination) number from Twilio's `To` param. */
  to: string | null;
  /** Resolved ORIGINAL caller number (see resolveCallerNumber). */
  from: string | null;
  /** This tenant's configured Twilio number (bot_config.twilio_number). */
  twilioNumber: string | undefined;
  /** Kill switch: false → do not run AI. */
  botEnabled: boolean;
  /** E.164 escalation number for the kill-switch <Dial> (may be undefined). */
  escalationNumber: string | undefined;
  /** Per-call wss URL Twilio should stream to; "" when PUBLIC_BASE_URL is unset. */
  wssUrl: string;
  /** Tenant Twilio auth token — HMAC key for the media-stream token. */
  authToken: string | undefined;
}

/**
 * Graceful fallback TwiML for every non-answer branch (kill switch, wrong number,
 * misconfiguration): dial the human escalation number when configured, otherwise
 * apologize and hang up. NEVER opens a Realtime session.
 */
function buildFallbackTwiml(escalationNumber: string | undefined): string {
  const response = new Twiml.VoiceResponse();
  if (escalationNumber && escalationNumber.trim() !== "") {
    response.dial({}, escalationNumber.trim());
  } else {
    response.say("Sorry, no one is available to take your call right now. Please call back later.");
    response.hangup();
  }
  return response.toString();
}

/**
 * TwiML for a call to a texting-only bot: politely decline and hang up (never open
 * a Realtime session or media stream). A texting-role tenant has no voice pipeline,
 * so any inbound call is out of scope — we say a brief line and end the call rather
 * than reject silently.
 */
export function buildRoleRejectTwiml(): string {
  const response = new Twiml.VoiceResponse();
  response.say(
    "Thanks for calling. This line is for text messages only. Please send us a text and we'll be happy to help."
  );
  response.hangup();
  return response.toString();
}

/**
 * Decide from a fresh `bots` snapshot whether the bot should answer this call.
 * Disabled when the row is missing, `active` is explicitly false, or the row is
 * trashed (`deleted_at` set). A null status means the fresh read errored — fail
 * OPEN (treat as active) so a transient DB blip never bricks the line; the
 * downstream kill switch (isBotEnabled) still guards the answer path.
 */
export function isBotActive(status: BotActiveStatus | null): boolean {
  if (status === null) return true; // couldn't verify → fail open
  if (!status.found) return false; // no tenant row → disabled
  if (status.active === false) return false; // dashboard toggle / trash
  if (status.deleted_at) return false; // trashed
  return true;
}

/**
 * TwiML for a disabled bot's inbound call. Forwards to the human escalation number
 * when configured (default <Dial> keeps the ORIGINAL caller's caller ID — no
 * callerId attribute), otherwise rejects the call. Returns the taken path for
 * logging. NEVER opens a media stream or a Realtime session.
 */
export function buildDisabledCallTwiml(escalationNumber: string | undefined): {
  xml: string;
  path: "dial" | "reject";
} {
  const response = new Twiml.VoiceResponse();
  const number = escalationNumber?.trim();
  if (number) {
    response.dial({}, number);
    return { xml: response.toString(), path: "dial" };
  }
  response.reject();
  return { xml: response.toString(), path: "reject" };
}

/**
 * Pure fail-closed TwiML decision. Gate order per the Twilio-native rebuild spec:
 *   a. Kill switch (bot disabled) FIRST → fallback TwiML. Ordered before the
 *      number check so a disabled bot never bridges regardless of routing.
 *   b. Called number (To) must equal this tenant's twilio_number → else fallback
 *      (defense against a Twilio number pointed at the wrong service/tenant).
 * Then misconfiguration guards (no wss URL / cannot mint token) also fall back.
 * Otherwise <Connect><Stream> to /media/{CallSid} with the caller number and a
 * call-bound HMAC token as custom parameters.
 */
export function buildVoiceTwiml(input: VoiceDecisionInput): string {
  // (a) Kill switch: no AI. Dial the human queue if configured, else hang up.
  if (!input.botEnabled) {
    logger.info("Bot disabled; returning fallback TwiML for Twilio call", {
      to: input.to,
      from: input.from,
      willDialEscalation: Boolean(input.escalationNumber && input.escalationNumber.trim() !== ""),
    });
    return buildFallbackTwiml(input.escalationNumber);
  }

  // (b) Called number must be THIS tenant's number — never answer others.
  if (
    !input.twilioNumber ||
    normalizePhoneNumber(input.to) !== normalizePhoneNumber(input.twilioNumber)
  ) {
    logger.warn("Rejecting Twilio call: To does not match this tenant's twilio_number", {
      to: input.to,
      hasTwilioNumber: Boolean(input.twilioNumber),
    });
    return buildFallbackTwiml(input.escalationNumber);
  }

  // Misconfiguration guard: without a public wss URL we cannot bridge media.
  if (!input.wssUrl) {
    logger.error("Cannot bridge Twilio media: PUBLIC_BASE_URL unset (no wss URL); fallback TwiML");
    return buildFallbackTwiml(input.escalationNumber);
  }

  // Security: the media WebSocket is unauthenticated (Twilio doesn't sign it), so
  // mint a short-lived, call-bound token the socket verifies on "start". Without a
  // CallSid or auth token we cannot bind/sign it — fall back rather than open an
  // unprotected stream.
  if (!input.callSid || !input.authToken) {
    logger.error("Cannot mint media-stream token (missing CallSid or auth token); fallback TwiML", {
      hasCallSid: Boolean(input.callSid),
      hasAuthToken: Boolean(input.authToken),
    });
    return buildFallbackTwiml(input.escalationNumber);
  }
  const token = createStreamToken(input.callSid, input.authToken);

  // Answer: open a bidirectional media stream to the per-call bridge endpoint.
  const response = new Twiml.VoiceResponse();
  const connect = response.connect();
  const stream = connect.stream({ url: input.wssUrl });
  stream.parameter({ name: "from", value: input.from ?? "" });
  stream.parameter({ name: "to", value: input.to ?? "" });
  stream.parameter({ name: "token", value: token });
  return response.toString();
}

export async function handleVoiceWebhook(req: Request, res: Response): Promise<Response> {
  // 1. Signature validation — fail closed. No token → cannot validate → reject.
  const authToken = await getTwilioAuthToken();
  const signature = req.header("X-Twilio-Signature") ?? "";
  const params = (req.body ?? {}) as Record<string, string>;
  if (!authToken || !twilio.validateRequest(authToken, signature, twilioVoiceWebhookUrl(), params)) {
    logger.warn("Rejected Twilio voice webhook: invalid or unverifiable signature", {
      hasToken: Boolean(authToken),
      hasSignature: Boolean(signature),
    });
    return res.status(403).send("invalid signature");
  }

  // 2. Refresh tenant config so dashboard edits (number, kill switch, credentials)
  //    take effect on the next call. Non-fatal on failure.
  await loadRemoteConfig();

  // 3. Resolve the original caller (handles RC-forwarded calls) and build the
  //    fail-closed TwiML from effective config + kill switch.
  const { twilio: tw, botRole } = await resolveEffectiveConfig();
  const callSid = params.CallSid ?? null;

  // 3a-role. Role gate (fresh per call): a texting-only bot has no voice pipeline —
  //   politely decline. Every voice role (answer_calls / outbound_calls /
  //   answer_and_followup) stays reachable so dialed-lead callbacks are answered.
  if (!roleAllows(botRole, "voice_inbound")) {
    logger.info("Voice call to a non-voice-role bot; returning polite reject TwiML", {
      botId: BOT_ID,
      botRole,
      callSid,
    });
    res.set("Content-Type", "text/xml");
    return res.status(200).send(buildRoleRejectTwiml());
  }

  // 3a. Active-flag gate: FRESH per-call read of bots.active (dashboard toggle +
  //     trash system). A disabled/missing/trashed bot never answers — forward to
  //     the escalation number or reject, with NO calls row, NO Realtime session,
  //     and NO media stream.
  const activeStatus = await fetchBotActiveStatus();
  if (!isBotActive(activeStatus)) {
    const { xml: disabledXml, path } = buildDisabledCallTwiml(tw.escalationNumber);
    logger.info("Bot disabled — forwarding call to escalation", {
      botId: BOT_ID,
      callSid,
      path,
    });
    res.set("Content-Type", "text/xml");
    return res.status(200).send(disabledXml);
  }

  const callerNumber = resolveCallerNumber({
    from: params.From ?? null,
    forwardedFrom: params.ForwardedFrom ?? null,
    to: params.To ?? null,
  });
  const xml = buildVoiceTwiml({
    callSid,
    to: params.To ?? null,
    from: callerNumber,
    twilioNumber: tw.number,
    botEnabled: isBotEnabled(),
    escalationNumber: tw.escalationNumber,
    wssUrl: callSid ? mediaStreamWssUrl(callSid) : "",
    authToken,
  });

  // 4. Two-phase call row, phase 1: INSERT on webhook receipt (before media starts)
  //    so the row exists even if the WebSocket never connects, and the status
  //    callback can still close it. Only when we actually answer (Connect/Stream).
  //    createCallRecord is an idempotent upsert (ignoreDuplicates on call_id), so
  //    the bridge's later onCallStarted never clobbers this row.
  if (callSid && xml.includes("<Stream")) {
    await createCallRecord({
      call_id: callSid,
      caller_number: callerNumber,
      started_at: new Date().toISOString(),
      transcript: [],
    });
  }

  res.set("Content-Type", "text/xml");
  return res.status(200).send(xml);
}

/**
 * Twilio call status callback (POST /webhooks/twilio/status). Registered on the
 * number config during provisioning with event 'completed' at minimum. Acts as a
 * backstop: if the media WebSocket dies without a clean "stop", the call row would
 * stay open (ended_at NULL) forever; here we close it when the call completes.
 * closeCallIfLive only writes when the row is still open, so a clean media-stream
 * teardown that already finalized the outcome is never overwritten.
 */
export async function handleStatusCallback(req: Request, res: Response): Promise<Response> {
  const authToken = await getTwilioAuthToken();
  const signature = req.header("X-Twilio-Signature") ?? "";
  const params = (req.body ?? {}) as Record<string, string>;
  const url = twilioStatusCallbackUrl();
  if (!authToken || !twilio.validateRequest(authToken, signature, url, params)) {
    logger.warn("Rejected Twilio status callback: invalid or unverifiable signature", {
      hasToken: Boolean(authToken),
      hasSignature: Boolean(signature),
    });
    return res.status(403).send("invalid signature");
  }

  const callSid = params.CallSid ?? null;
  const callStatus = params.CallStatus ?? "";
  // Terminal statuses that mean the call is over and its row should be closed.
  const terminal = ["completed", "busy", "failed", "no-answer", "canceled"];
  if (callSid && terminal.includes(callStatus)) {
    logger.info("Twilio status callback: closing call row if still live", { callSid, callStatus });
    const outcome = callStatus === "completed" ? "abandoned" : "no_answer";
    await closeCallIfLive(callSid, outcome);
  }
  return res.status(204).send();
}

twilioVoiceRouter.post("/webhooks/twilio/voice", handleVoiceWebhook);
twilioVoiceRouter.post("/webhooks/twilio/status", handleStatusCallback);
