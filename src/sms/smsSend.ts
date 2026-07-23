import { resolveEffectiveConfig } from "../config";
import { logger } from "../logger";
import { getTwilioClient } from "../twilio/client";
import { sendRcSms } from "./rcSms";
import {
  insertTextMessage,
  isPhoneHandedOff,
  isPhoneOptedOut,
  type TextConversationRow,
} from "./smsQueries";

/** Outcome of an outbound send attempt. */
export interface SendResult {
  sent: boolean;
  /** Why the send was skipped (opted_out / handed_off / no_credentials / no_number / error). */
  reason?: string;
  /** RC message-store id captured on a successful RingCentral send (id-match echo detection). */
  providerMessageId?: string;
}

/**
 * Send ONE outbound SMS on a conversation and record it.
 *
 * Compliance gate runs FIRST, on every send:
 *   - If the number has opted out on this bot, we NEVER send (hard stop).
 *
 * The body is sent VERBATIM — no prefix or opt-out suffix is auto-injected. The
 * operator's opener/template is responsible for any company-name or STOP language.
 *
 * Reply channel follows the conversation: a 'ringcentral' conversation sends via
 * the RingCentral client (sendRcSms), everything else via this tenant's Twilio REST
 * client (DB-first credentials) and text_number as the From. Never throws — a send
 * failure is logged and returned as { sent: false } so callers (webhook/triggers)
 * stay non-fatal.
 */
export async function sendSms(input: {
  conversation: TextConversationRow;
  body: string;
  firstBotInitiated?: boolean;
}): Promise<SendResult> {
  const { conversation } = input;
  const phone = conversation.phone_number;

  // Compliance: never text an opted-out number (checked fresh every send).
  if (await isPhoneOptedOut(phone)) {
    logger.info("Skipping outbound SMS: number is opted out", {
      conversationId: conversation.id,
    });
    return { sent: false, reason: "opted_out" };
  }

  // Handoff: once a human agent took over this client, the bot goes silent for them
  // permanently — never send another outbound (checked fresh every send, per phone).
  if (await isPhoneHandedOff(phone)) {
    logger.info("Skipping outbound SMS: conversation handed off to human", {
      conversationId: conversation.id,
    });
    return { sent: false, reason: "handed_off" };
  }

  const body = input.body;

  // Reply out the SAME channel the conversation lives on.
  const result =
    conversation.channel === "ringcentral"
      ? await sendViaRingCentral(conversation, phone, body)
      : await sendViaTwilio(conversation, phone, body);
  if (!result.sent) return result;

  await insertTextMessage({
    conversationId: conversation.id,
    direction: "outbound",
    body,
    providerMessageId: result.providerMessageId ?? null,
  });
  return { sent: true, providerMessageId: result.providerMessageId };
}

/** Twilio-channel send: tenant text_number as From via the REST client. */
async function sendViaTwilio(
  conversation: TextConversationRow,
  phone: string,
  body: string
): Promise<SendResult> {
  const { text } = await resolveEffectiveConfig();
  const from = text.number;
  if (!from) {
    logger.error("Cannot send SMS: no text_number configured for tenant", {
      conversationId: conversation.id,
    });
    return { sent: false, reason: "no_number" };
  }

  const client = await getTwilioClient();
  if (!client) {
    logger.error("Cannot send SMS: no Twilio REST credentials for tenant", {
      conversationId: conversation.id,
    });
    return { sent: false, reason: "no_credentials" };
  }

  try {
    await client.messages.create({ from, to: phone, body });
  } catch (err) {
    logger.error("Failed to send SMS via Twilio", {
      conversationId: conversation.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { sent: false, reason: "error" };
  }
  return { sent: true };
}

/** RingCentral-channel send: rc_sms_number as From via the RC client. */
async function sendViaRingCentral(
  conversation: TextConversationRow,
  phone: string,
  body: string
): Promise<SendResult> {
  const res = await sendRcSms({ to: phone, text: body });
  if (!res.sent) {
    return { sent: false, reason: res.reason ?? "error" };
  }
  return { sent: true, providerMessageId: res.providerMessageId };
}
