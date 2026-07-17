import { Router, Request, Response } from "express";
import twilio, { twiml as Twiml } from "twilio";
import { config, mediaStreamWssUrl, resolveEffectiveConfig } from "../config";
import { logger } from "../logger";
import { isBotEnabled, loadRemoteConfig } from "../db/remoteConfig";
import { getTwilioAuthToken } from "./client";

/**
 * Twilio inbound-call webhook (POST /webhooks/twilio/voice).
 *
 * Twilio POSTs application/x-www-form-urlencoded call params here when a call
 * reaches this tenant's Twilio number (RC forwards the RC number to it). We:
 *   1. Validate the X-Twilio-Signature (reject 403 on missing token / bad sig).
 *   2. Reload remote config so dashboard edits apply on the next call.
 *   3. Fail-closed decide the TwiML (see buildVoiceTwiml): only answer OUR number
 *      when voice_provider is 'twilio', honor the kill switch, else <Reject>.
 *   4. On answer, <Connect><Stream> to the media WebSocket, passing the caller
 *      number as a custom <Parameter> so the socket knows who is calling.
 */
export const twilioVoiceRouter = Router();

/** Digits-only phone comparison; drops a leading US "1". Mirrors webhooks.ts. */
function normalizePhoneNumber(value: string | null | undefined): string {
  if (!value) return "";
  let digits = value.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits;
}

export interface VoiceDecisionInput {
  /** Called (destination) number from Twilio's `To` param. */
  to: string | null;
  /** Caller number from Twilio's `From` param. */
  from: string | null;
  /** This tenant's configured Twilio number (bot_config.twilio_number). */
  twilioNumber: string | undefined;
  /** Effective voice provider ('ringcentral' | 'twilio'). */
  voiceProvider: string;
  /** Kill switch: false → do not run AI. */
  botEnabled: boolean;
  /** E.164 escalation number for the kill-switch <Dial> (may be undefined). */
  escalationNumber: string | undefined;
  /** wss URL Twilio should stream to; "" when PUBLIC_BASE_URL is unset. */
  wssUrl: string;
}

/**
 * Pure fail-closed TwiML decision. Order (per spec):
 *   a. voice_provider must be 'twilio' AND twilio_number set → else <Reject>.
 *   b. called number (To) must equal twilio_number → else <Reject>.
 *   c. kill switch (bot disabled) → <Dial>escalation_number</Dial> if set, else <Hangup>.
 * Otherwise <Connect><Stream> with the caller number as a custom parameter.
 */
export function buildVoiceTwiml(input: VoiceDecisionInput): string {
  const response = new Twiml.VoiceResponse();

  // (a) Provider must be Twilio and a number must be assigned.
  if (input.voiceProvider !== "twilio" || !input.twilioNumber || input.twilioNumber.trim() === "") {
    logger.warn("Rejecting Twilio call: voice_provider not 'twilio' or no twilio_number assigned", {
      voiceProvider: input.voiceProvider,
      hasTwilioNumber: Boolean(input.twilioNumber),
      to: input.to,
    });
    response.reject();
    return response.toString();
  }

  // (b) Called number must be THIS tenant's number — never answer others.
  if (normalizePhoneNumber(input.to) !== normalizePhoneNumber(input.twilioNumber)) {
    logger.warn("Rejecting Twilio call: To does not match this tenant's twilio_number", {
      to: input.to,
    });
    response.reject();
    return response.toString();
  }

  // (c) Kill switch: no AI. Dial the human queue if configured, else hang up.
  if (!input.botEnabled) {
    if (input.escalationNumber && input.escalationNumber.trim() !== "") {
      logger.info("Bot disabled; dialing escalation number for Twilio call", {
        to: input.to,
        from: input.from,
      });
      response.dial({}, input.escalationNumber.trim());
    } else {
      logger.info("Bot disabled and no escalation_number; hanging up Twilio call", {
        to: input.to,
        from: input.from,
      });
      response.hangup();
    }
    return response.toString();
  }

  // Misconfiguration guard: without a public wss URL we cannot bridge media.
  if (!input.wssUrl) {
    logger.error("Cannot bridge Twilio media: PUBLIC_BASE_URL unset (no wss URL); rejecting call");
    response.reject();
    return response.toString();
  }

  // Answer: open a bidirectional media stream to the bridge.
  const connect = response.connect();
  const stream = connect.stream({ url: input.wssUrl });
  stream.parameter({ name: "from", value: input.from ?? "" });
  stream.parameter({ name: "to", value: input.to ?? "" });
  return response.toString();
}

/** Full public URL Twilio signed, used for signature validation. */
function requestUrl(): string {
  const base = config.publicBaseUrl.trim().replace(/\/$/, "");
  return `${base}/webhooks/twilio/voice`;
}

export async function handleVoiceWebhook(req: Request, res: Response): Promise<Response> {
  // 1. Signature validation — fail closed. No token → cannot validate → reject.
  const authToken = await getTwilioAuthToken();
  const signature = req.header("X-Twilio-Signature") ?? "";
  const params = (req.body ?? {}) as Record<string, string>;
  if (!authToken || !twilio.validateRequest(authToken, signature, requestUrl(), params)) {
    logger.warn("Rejected Twilio voice webhook: invalid or unverifiable signature", {
      hasToken: Boolean(authToken),
      hasSignature: Boolean(signature),
    });
    return res.status(403).send("invalid signature");
  }

  // 2. Refresh tenant config so dashboard edits (provider, number, kill switch,
  //    credentials) take effect on the next call. Non-fatal on failure.
  await loadRemoteConfig();

  // 3. Fail-closed TwiML decision from effective config + kill switch.
  const { twilio: tw } = await resolveEffectiveConfig();
  const xml = buildVoiceTwiml({
    to: params.To ?? null,
    from: params.From ?? null,
    twilioNumber: tw.number,
    voiceProvider: tw.voiceProvider,
    botEnabled: isBotEnabled(),
    escalationNumber: tw.escalationNumber,
    wssUrl: mediaStreamWssUrl(),
  });

  res.set("Content-Type", "text/xml");
  return res.status(200).send(xml);
}

twilioVoiceRouter.post("/webhooks/twilio/voice", handleVoiceWebhook);
