import { Router, Request, Response } from "express";
import twilio, { twiml as Twiml } from "twilio";
import {
  mediaStreamWssUrl,
  resolveEffectiveConfig,
  twilioVoiceOutboundWebhookUrl,
} from "../config";
import { logger } from "../logger";
import { BOT_ID, loadRemoteConfig } from "../db/remoteConfig";
import { getTwilioAuthToken } from "../twilio/client";
import { createStreamToken } from "../twilio/streamToken";
import { createCallRecord } from "../db/queries";
import { setContactCallOutcome } from "./campaignQueries";
import { takeOutboundCall } from "./outboundState";

/**
 * Twilio OUTBOUND campaign-call webhook (POST /webhooks/twilio/voice-outbound).
 *
 * The dialer (outboundWorker) places calls with url=.../voice-outbound?contactId=…
 * and machineDetection enabled. Twilio requests TwiML here once the call connects.
 * We:
 *   1. Validate the X-Twilio-Signature against the exact configured URL (which
 *      INCLUDES the ?contactId query string). Fail closed → 403.
 *   2. If Twilio's AnsweredBy says a machine/fax picked up: hang up (RVM handles
 *      voicemails) and mark the contact failed. NEVER open a Realtime session.
 *   3. Otherwise (human / unknown): phase-1 INSERT the outbound call row linked to
 *      the contact, then <Connect><Stream> to the same per-call media bridge as
 *      inbound (call-bound HMAC token as a <Parameter>). The bridge marks the call
 *      outbound (see outboundState + onCallStarted) so the bot opens the SR22 script.
 */
export const outboundVoiceRouter = Router();

/** Parse the ?contactId query value into a numeric contact id, or null. */
function parseContactId(value: unknown): number | null {
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return parseInt(value.trim(), 10);
  return null;
}

/**
 * True when Twilio's AnsweredBy indicates a non-human pickup (answering machine or
 * fax) that we should hang up on. 'human'/'unknown'/absent → treated as human so we
 * bridge rather than drop a real person.
 */
export function isMachineAnswer(answeredBy: string | undefined | null): boolean {
  const a = (answeredBy ?? "").trim().toLowerCase();
  return a.startsWith("machine") || a === "fax";
}

/** TwiML that immediately hangs up (answering machine detected — RVM covers it). */
export function buildOutboundHangupTwiml(): string {
  const response = new Twiml.VoiceResponse();
  response.hangup();
  return response.toString();
}

export interface OutboundStreamInput {
  callSid: string | null;
  /** The dialed lead number (Twilio `To`), surfaced to the bridge as the caller. */
  leadNumber: string | null;
  /** This tenant's Twilio number (Twilio `From` on an outbound call). */
  twilioNumber: string | null;
  /** Per-call wss URL; "" when PUBLIC_BASE_URL is unset. */
  wssUrl: string;
  /** Tenant Twilio auth token — HMAC key for the media-stream token. */
  authToken: string | undefined;
}

/**
 * Build the answer TwiML for a human-answered outbound call: <Connect><Stream> to
 * the per-call media bridge with a call-bound HMAC token. Falls back to a plain
 * hangup when we can't bridge (no wss URL / cannot mint the token) rather than open
 * an unprotected stream — there's no human queue to dial on an outbound call.
 */
export function buildOutboundStreamTwiml(input: OutboundStreamInput): string {
  if (!input.wssUrl || !input.callSid || !input.authToken) {
    logger.error("Cannot bridge outbound Twilio media (missing wss URL/CallSid/token); hanging up", {
      hasWssUrl: Boolean(input.wssUrl),
      hasCallSid: Boolean(input.callSid),
      hasAuthToken: Boolean(input.authToken),
    });
    return buildOutboundHangupTwiml();
  }
  const token = createStreamToken(input.callSid, input.authToken);
  const response = new Twiml.VoiceResponse();
  const connect = response.connect();
  const stream = connect.stream({ url: input.wssUrl });
  // `from` is the dialed lead so the bridge personalizes with the lead's record.
  stream.parameter({ name: "from", value: input.leadNumber ?? "" });
  stream.parameter({ name: "to", value: input.twilioNumber ?? "" });
  stream.parameter({ name: "token", value: token });
  return response.toString();
}

export async function handleOutboundVoiceWebhook(req: Request, res: Response): Promise<Response> {
  // 1. Signature validation — fail closed. The signed URL includes the ?contactId
  //    query string, so reconstruct it from the raw query value.
  const authToken = await getTwilioAuthToken();
  const signature = req.header("X-Twilio-Signature") ?? "";
  const params = (req.body ?? {}) as Record<string, string>;
  const rawContactId = typeof req.query.contactId === "string" ? req.query.contactId : "";
  const url = twilioVoiceOutboundWebhookUrl(rawContactId);
  if (!authToken || !twilio.validateRequest(authToken, signature, url, params)) {
    logger.warn("Rejected Twilio voice-outbound webhook: invalid or unverifiable signature", {
      hasToken: Boolean(authToken),
      hasSignature: Boolean(signature),
    });
    return res.status(403).send("invalid signature");
  }

  const callSid = params.CallSid ?? null;
  const contactId = parseContactId(req.query.contactId);
  const answeredBy = params.AnsweredBy ?? null;

  // 2. Answering machine / fax → hang up (RVM covers voicemails). Free the
  //    concurrency slot and mark the contact failed so the batch moves on. The
  //    later 'completed' status callback then finds no registry entry and no-ops.
  if (isMachineAnswer(answeredBy)) {
    logger.info("Outbound call reached a machine; hanging up", {
      botId: BOT_ID,
      callSid,
      contactId,
      answeredBy,
    });
    if (callSid) takeOutboundCall(callSid);
    if (contactId !== null) {
      await setContactCallOutcome(contactId, "failed", `answering_machine:${answeredBy}`, callSid);
    }
    res.set("Content-Type", "text/xml");
    return res.status(200).send(buildOutboundHangupTwiml());
  }

  // 3. Human/unknown → bridge to the Realtime pipeline. Refresh config so dashboard
  //    edits (number, credentials) apply, then answer with Connect/Stream.
  await loadRemoteConfig();
  const { twilio: tw } = await resolveEffectiveConfig();
  const leadNumber = params.To ?? null;
  const xml = buildOutboundStreamTwiml({
    callSid,
    leadNumber,
    twilioNumber: tw.number ?? null,
    wssUrl: callSid ? mediaStreamWssUrl(callSid) : "",
    authToken,
  });

  // Phase-1 call row: INSERT the outbound call linked to its contact before media
  // starts, so it exists even if the WebSocket never connects. Idempotent upsert —
  // the bridge's later onCallStarted never clobbers it. Only when we actually bridge.
  if (callSid && xml.includes("<Stream")) {
    await createCallRecord({
      call_id: callSid,
      caller_number: leadNumber,
      started_at: new Date().toISOString(),
      transcript: [],
      direction: "outbound",
      campaign_contact_id: contactId,
    });
  }

  res.set("Content-Type", "text/xml");
  return res.status(200).send(xml);
}

outboundVoiceRouter.post("/webhooks/twilio/voice-outbound", handleOutboundVoiceWebhook);
