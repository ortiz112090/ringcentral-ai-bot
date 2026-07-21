import { Router, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import twilio, { twiml as Twiml } from "twilio";
import { config, resolveEffectiveConfig, twilioSmsWebhookUrl } from "../config";
import { logger } from "../logger";
import { BOT_ID, loadRemoteConfig } from "../db/remoteConfig";
import { getTwilioAuthToken } from "../twilio/client";
import { handleInboundSms, sendWebLeadText } from "./smsService";

/**
 * SMS HTTP endpoints:
 *   - POST /webhooks/twilio/sms — Twilio inbound-SMS webhook (signature-validated,
 *     fail-closed). Routes by the "To" number to this tenant's text_number; an
 *     unknown number or a disabled text bot returns empty TwiML (no reply).
 *   - POST /v1/leads/:botId/text-outreach — authenticated web-lead outreach
 *     (shared-secret header), fires the opener for a new lead.
 *
 * Mirrors voiceWebhook.ts conventions: validate X-Twilio-Signature against the
 * tenant auth token, reload remote config so dashboard edits apply next message,
 * and never open the AI path on a non-matching/disabled branch.
 */
export const smsRouter = Router();

/** Digits-only phone comparison, dropping a leading US "1" (mirrors voiceWebhook). */
function normalizePhoneNumber(value: string | null | undefined): string {
  if (!value) return "";
  let digits = value.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits;
}

/** Empty TwiML messaging response (200) — acknowledges without replying inline. */
function emptyTwiml(res: Response): Response {
  res.set("Content-Type", "text/xml");
  return res.status(200).send(new Twiml.MessagingResponse().toString());
}

export async function handleSmsWebhook(req: Request, res: Response): Promise<Response> {
  // 1. Signature validation — fail closed (no token → cannot validate → 403).
  const authToken = await getTwilioAuthToken();
  const signature = req.header("X-Twilio-Signature") ?? "";
  const params = (req.body ?? {}) as Record<string, string>;
  if (!authToken || !twilio.validateRequest(authToken, signature, twilioSmsWebhookUrl(), params)) {
    logger.warn("Rejected Twilio SMS webhook: invalid or unverifiable signature", {
      hasToken: Boolean(authToken),
      hasSignature: Boolean(signature),
    });
    return res.status(403).send("invalid signature");
  }

  // 2. Refresh tenant config so dashboard edits (text number, kill switch) apply.
  await loadRemoteConfig();
  const { text } = await resolveEffectiveConfig();

  // 3. Kill switch: text bot disabled → acknowledge with no reply.
  if (!text.enabled) {
    logger.info("Inbound SMS ignored: text bot disabled for tenant", { botId: BOT_ID });
    return emptyTwiml(res);
  }

  // 4. Route by destination number: the "To" must be THIS tenant's text_number.
  const to = params.To ?? null;
  if (!text.number || normalizePhoneNumber(to) !== normalizePhoneNumber(text.number)) {
    logger.warn("Inbound SMS ignored: To does not match this tenant's text_number", {
      hasTextNumber: Boolean(text.number),
    });
    return emptyTwiml(res);
  }

  const from = (params.From ?? "").trim();
  const body = params.Body ?? "";
  if (!from) {
    logger.warn("Inbound SMS ignored: missing From");
    return emptyTwiml(res);
  }

  // Process asynchronously? No — await so errors are logged, but the handler itself
  // never throws (handleInboundSms is failure-tolerant). Reply is sent via REST.
  try {
    await handleInboundSms({ from, body });
  } catch (err) {
    logger.error("handleInboundSms threw unexpectedly", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return emptyTwiml(res);
}

/** Constant-time string compare that never throws on length mismatch. */
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function handleTextOutreach(req: Request, res: Response): Promise<Response> {
  // Auth: shared-secret header. Fail closed when no secret is configured so the
  // endpoint is never open to unauthenticated outreach.
  const expected = config.textOutreachSecret.trim();
  if (expected === "") {
    logger.error("Text-outreach endpoint hit but TEXT_OUTREACH_SECRET is unset; refusing");
    return res.status(503).json({ error: "outreach_not_configured" });
  }
  const provided = (req.header("X-Outreach-Secret") ?? "").trim();
  if (!provided || !secretsMatch(provided, expected)) {
    logger.warn("Rejected text-outreach: bad or missing shared secret");
    return res.status(401).json({ error: "unauthorized" });
  }

  // The path botId must match this deployment's tenant (single-tenant per deploy).
  if (req.params.botId !== BOT_ID) {
    logger.warn("Rejected text-outreach: botId does not match this tenant", {
      pathBotId: req.params.botId,
    });
    return res.status(404).json({ error: "unknown_bot" });
  }

  const bodyObj = (req.body ?? {}) as { phone?: unknown; name?: unknown };
  const phone = typeof bodyObj.phone === "string" ? bodyObj.phone.trim() : "";
  const name = typeof bodyObj.name === "string" ? bodyObj.name.trim() : null;
  if (phone === "") {
    return res.status(400).json({ error: "phone_required" });
  }

  const sent = await sendWebLeadText({ phone, name });
  return res.status(202).json({ accepted: true, sent });
}

smsRouter.post("/webhooks/twilio/sms", handleSmsWebhook);
smsRouter.post("/v1/leads/:botId/text-outreach", handleTextOutreach);
