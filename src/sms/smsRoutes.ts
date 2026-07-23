import { Router, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import twilio, { twiml as Twiml } from "twilio";
import { config, resolveEffectiveConfig, twilioSmsWebhookUrl } from "../config";
import { logger } from "../logger";
import { BOT_ID, loadRemoteConfig } from "../db/remoteConfig";
import { getTwilioAuthToken } from "../twilio/client";
import { handleAgentTakeover, handleInboundSms, sendWebLeadText } from "./smsService";
import { roleAllows } from "../roles";
import { isGateReason, runSync } from "../campaigns/velocifySync";

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
  const { text, botRole } = await resolveEffectiveConfig();

  // 3-role. Role gate (fresh per message): SMS runs only for the texting role.
  //   A non-texting bot acknowledges with no reply (never opens the AI path).
  if (!roleAllows(botRole, "sms")) {
    logger.info("Inbound SMS ignored: tenant role does not allow SMS", { botId: BOT_ID, botRole });
    return emptyTwiml(res);
  }

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
  // Refresh tenant config so dashboard edits (text_enabled, kill switch) apply to
  // test/web-lead sends immediately, not on the next unrelated refresh.
  await loadRemoteConfig();
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

  // Role gate: web-lead outreach is part of the SMS pipeline (texting role only).
  const { botRole } = await resolveEffectiveConfig();
  if (!roleAllows(botRole, "sms")) {
    logger.info("Text-outreach rejected: tenant role does not allow SMS", { botId: BOT_ID, botRole });
    return res.status(403).json({ error: "sms_role_disabled" });
  }

  const sent = await sendWebLeadText({ phone, name });
  return res.status(202).json({ accepted: true, sent });
}

/**
 * Manual Velocify sync trigger: POST /v1/leads/:botId/velocify-sync. Auth mirrors
 * handleTextOutreach EXACTLY — fail-closed 503 when TEXT_OUTREACH_SECRET is unset,
 * constant-time X-Outreach-Secret match (401 otherwise), and the path botId must
 * equal this deployment's tenant (404 otherwise). Runs runSync() immediately
 * (ignoring the scheduled interval, still respecting the enabled + report-id + creds
 * gates) and returns 200 with the counts JSON, or a gated {accepted:false, reason}
 * (409 for a gate miss, 502 for a fetch/parse failure).
 */
export async function handleVelocifySync(req: Request, res: Response): Promise<Response> {
  await loadRemoteConfig();

  const expected = config.textOutreachSecret.trim();
  if (expected === "") {
    logger.error("Velocify sync endpoint hit but TEXT_OUTREACH_SECRET is unset; refusing");
    return res.status(503).json({ error: "outreach_not_configured" });
  }
  const provided = (req.header("X-Outreach-Secret") ?? "").trim();
  if (!provided || !secretsMatch(provided, expected)) {
    logger.warn("Rejected velocify-sync: bad or missing shared secret");
    return res.status(401).json({ error: "unauthorized" });
  }
  if (req.params.botId !== BOT_ID) {
    logger.warn("Rejected velocify-sync: botId does not match this tenant", {
      pathBotId: req.params.botId,
    });
    return res.status(404).json({ error: "unknown_bot" });
  }

  const result = await runSync(new Date(), { manual: true });
  if (result.accepted) {
    return res.status(200).json({
      accepted: true,
      counts: result.counts,
      campaignId: result.campaignId,
      campaignName: result.campaignName,
    });
  }
  const status = isGateReason(result.reason) ? 409 : 502;
  return res.status(status).json({ accepted: false, reason: result.reason });
}

/**
 * Small fixed-size LRU of recently-seen RingCentral message ids, the fast first
 * line of inbound dedupe (the durable second line is the provider_message_id check
 * in handleInboundSms). RC can redeliver the same message-store event (e.g. on a
 * slow ack); this keeps us from double-processing within a single process without a
 * DB round-trip. Bounded so it can never grow unboundedly.
 */
const RC_DEDUPE_MAX = 500;
const rcSeenMessageIds = new Set<string>();

/** Record an id in the LRU; returns true if it was ALREADY present (a duplicate). */
function rcMessageSeen(id: string): boolean {
  if (rcSeenMessageIds.has(id)) return true;
  rcSeenMessageIds.add(id);
  if (rcSeenMessageIds.size > RC_DEDUPE_MAX) {
    // Evict the oldest (insertion-ordered) entry.
    const oldest = rcSeenMessageIds.values().next().value;
    if (oldest !== undefined) rcSeenMessageIds.delete(oldest);
  }
  return false;
}

/** Test-only: clear the in-memory RC dedupe LRU between cases. */
export function __resetRcDedupeForTests(): void {
  rcSeenMessageIds.clear();
}

/**
 * RingCentral inbound-SMS webhook — the RC doorway into the SAME SMS pipeline as the
 * Twilio webhook (handleInboundSms). Steps:
 *   1. Fail-closed config check: missing RC_SMS_WEBHOOK_TOKEN → 503.
 *   2. Auth: the shared secret rides in the subscription address as `?token=`, which
 *      RC echoes on EVERY delivery (RC does not send a Verification-Token header on
 *      real notifications). Accept a matching `?token=` query param; also accept a
 *      matching `Verification-Token` or `Validation-Token` header as a fallback in
 *      case RC starts sending them. Any one match is enough; otherwise → 403.
 *   3. Subscription-validation handshake: echo any `Validation-Token` header back.
 *      The validation probe carries no event body, so it returns 200 at step 4.
 *   4. Parse the message-store instant event; only Inbound SMS is processed.
 *   5. Role gate + kill switch + destination match (fail closed) + dedupe, then hand
 *      off to handleInboundSms on the 'ringcentral' channel.
 * Always acknowledges 200 to RC after auth so a processing hiccup never trips RC's
 * delivery-failure blacklisting; handleInboundSms is failure-tolerant.
 */
export async function handleRcSmsWebhook(req: Request, res: Response): Promise<Response> {
  // 1. Fail-closed config check.
  const expected = config.rcSmsWebhookToken.trim();
  if (expected === "") {
    logger.error("RingCentral SMS webhook hit but RC_SMS_WEBHOOK_TOKEN is unset; refusing");
    return res.status(503).send("rc_sms_not_configured");
  }

  // 2. Auth: query-param token (RC echoes the subscription address) OR a matching
  //    Verification-Token / Validation-Token header. Constant-time compare each.
  const queryToken = typeof req.query?.token === "string" ? req.query.token.trim() : "";
  const validationToken = req.header("Validation-Token");
  const verificationToken = (req.header("Verification-Token") ?? "").trim();
  const validationValue = typeof validationToken === "string" ? validationToken.trim() : "";
  const authorized =
    (queryToken !== "" && secretsMatch(queryToken, expected)) ||
    (verificationToken !== "" && secretsMatch(verificationToken, expected)) ||
    (validationValue !== "" && secretsMatch(validationValue, expected));
  if (!authorized) {
    logger.warn("Rejected RingCentral SMS webhook: bad or missing webhook token");
    return res.status(403).send("invalid webhook token");
  }

  // 3. Subscription-validation handshake — echo the Validation-Token header (if any).
  //    A probe carries no event body and falls through to the 200 at step 4.
  if (validationToken) {
    res.set("Validation-Token", validationToken);
  }

  // 4. Parse the message-store instant event. body.body carries the message. Both
  //    Inbound (a client texting us) and Outbound (our own send OR a human agent
  //    typing in the RC app) SMS events are inspected; other events are ignored.
  const messageBody = (req.body ?? {}).body as
    | {
        id?: unknown;
        direction?: unknown;
        from?: { phoneNumber?: unknown };
        to?: Array<{ phoneNumber?: unknown }>;
        subject?: unknown;
      }
    | undefined;
  const direction = messageBody?.direction;
  if (!messageBody || (direction !== "Inbound" && direction !== "Outbound")) {
    // A non-message event (e.g. the validation probe) or an unhandled type: ack + ignore.
    return res.status(200).send();
  }

  const text = typeof messageBody.subject === "string" ? messageBody.subject : "";
  const messageId = messageBody.id != null ? String(messageBody.id) : "";

  // Fast in-memory dedupe before any DB/engine work — a redelivered event (either
  // direction) must not re-process (re-reply, or re-trigger takeover detection).
  if (messageId && rcMessageSeen(messageId)) {
    logger.info("RC SMS skipped: duplicate message id (in-memory LRU)", { messageId });
    return res.status(200).send();
  }

  // 5. Refresh tenant config so dashboard edits (rc_sms_number, kill switch) apply.
  await loadRemoteConfig();
  const { text: textCfg, botRole } = await resolveEffectiveConfig();

  // Role gate (fresh per message): SMS runs only for the texting role.
  if (!roleAllows(botRole, "sms")) {
    logger.info("RC SMS ignored: tenant role does not allow SMS", { botId: BOT_ID, botRole });
    return res.status(200).send();
  }

  // Kill switch: text bot disabled → acknowledge with no reply.
  if (!textCfg.enabled) {
    logger.info("RC SMS ignored: text bot disabled for tenant", { botId: BOT_ID });
    return res.status(200).send();
  }

  // Outbound: distinguish the bot's own echo from a human-agent takeover. The client
  // is the recipient (to[0]); resolve it and delegate to the takeover detector.
  if (direction === "Outbound") {
    const clientPhone =
      Array.isArray(messageBody.to) && typeof messageBody.to[0]?.phoneNumber === "string"
        ? messageBody.to[0].phoneNumber.trim()
        : "";
    if (!clientPhone) {
      logger.warn("Outbound RC SMS ignored: missing to[0].phoneNumber");
      return res.status(200).send();
    }
    try {
      await handleAgentTakeover({ eventId: messageId, clientPhone, body: text });
    } catch (err) {
      logger.error("handleAgentTakeover threw unexpectedly", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return res.status(200).send();
  }

  const from = typeof messageBody.from?.phoneNumber === "string" ? messageBody.from.phoneNumber.trim() : "";
  if (!from) {
    logger.warn("Inbound RC SMS ignored: missing from.phoneNumber");
    return res.status(200).send();
  }

  // Destination match (fail closed): the message must be addressed to THIS tenant's
  // rc_sms_number. An unset rc_sms_number means RC texting is off → refuse.
  if (!textCfg.rcSmsNumber || !rcDestinationMatches(messageBody.to, textCfg.rcSmsNumber)) {
    logger.warn("Inbound RC SMS ignored: destination does not match this tenant's rc_sms_number", {
      botId: BOT_ID,
      hasRcSmsNumber: Boolean(textCfg.rcSmsNumber),
    });
    return res.status(200).send();
  }

  try {
    await handleInboundSms({
      from,
      body: text,
      channel: "ringcentral",
      providerMessageId: messageId || null,
    });
  } catch (err) {
    logger.error("handleInboundSms threw unexpectedly (RingCentral channel)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return res.status(200).send();
}

/** True when one of the RC `to[]` numbers matches this tenant's rc_sms_number. */
function rcDestinationMatches(
  to: Array<{ phoneNumber?: unknown }> | undefined,
  rcSmsNumber: string
): boolean {
  const target = normalizePhoneNumber(rcSmsNumber);
  if (!target) return false;
  const entries = Array.isArray(to) ? to : [];
  return entries.some(
    (t) => normalizePhoneNumber(typeof t?.phoneNumber === "string" ? t.phoneNumber : "") === target
  );
}

smsRouter.post("/webhooks/twilio/sms", handleSmsWebhook);
smsRouter.post("/webhooks/ringcentral/sms", handleRcSmsWebhook);
smsRouter.post("/v1/leads/:botId/text-outreach", handleTextOutreach);
smsRouter.post("/v1/leads/:botId/velocify-sync", handleVelocifySync);
