import { resolveEffectiveConfig } from "../config";
import { logger } from "../logger";
import { getTwilioClient } from "../twilio/client";
import { findLeadByPhone, getLeadFields } from "../db/queries";
import type { LeadRecord } from "../db/types";
import {
  buildHelpReply,
  classifyInboundKeyword,
  isWithinTextingWindow,
} from "./smsCompliance";
import { runSmsTurn, type SmsChatTurn } from "./smsEngine";
import { sendSms } from "./smsSend";
import {
  createConversation,
  findConversationByPhone,
  getConversationMessages,
  getTextStages,
  insertTextMessage,
  isPhoneOptedOut,
  updateConversationStatus,
  type TextConversationRow,
  type TextStageRow,
  type TextTrigger,
} from "./smsQueries";

/**
 * SMS orchestration: ties the compliance layer, conversation store, engine, and
 * sender together for all three triggers (inbound reply, missed-call follow-up,
 * web-lead outreach). Kept separate from the HTTP routes so it is unit-testable
 * without Express. Every path is failure-tolerant and multi-tenant (BOT_ID scoped
 * inside the queries).
 */

/** Convert stored messages (oldest→newest) into chat turns for the engine. */
function toChatTurns(
  messages: { direction: "inbound" | "outbound"; body: string }[]
): SmsChatTurn[] {
  return messages.map((m) => ({
    role: m.direction === "inbound" ? "user" : "assistant",
    content: m.body,
  }));
}

/**
 * Handle one inbound SMS (already signature-verified + routed to this tenant).
 * Returns nothing — replies are sent via the Twilio REST API inside sendSms so the
 * webhook can just return empty TwiML. Order of operations:
 *   1. STOP/UNSUBSCRIBE → mark opted_out, no reply (Twilio sends its own confirm).
 *   2. HELP → identification reply.
 *   3. Already opted out → ignore (never text again).
 *   4. Otherwise run the engine and send its reply; honor escalate / opt-out tools.
 */
export async function handleInboundSms(input: {
  from: string;
  body: string;
}): Promise<void> {
  const { from, body } = input;
  const keyword = classifyInboundKeyword(body);

  // 1. STOP: opt the number out and stop. Record the inbound for the audit trail.
  if (keyword === "stop") {
    const convo =
      (await findConversationByPhone(from)) ??
      (await createConversation({ phone_number: from, trigger: "inbound" }));
    if (convo) {
      await insertTextMessage({ conversationId: convo.id, direction: "inbound", body });
      await updateConversationStatus(convo.id, "opted_out");
    }
    logger.info("Inbound STOP: conversation opted out", { hasConvo: Boolean(convo) });
    return;
  }

  // 3. Opt-out is sticky: never engage a number that already opted out.
  if (await isPhoneOptedOut(from)) {
    logger.info("Ignoring inbound SMS from opted-out number");
    return;
  }

  const convo =
    (await findConversationByPhone(from)) ??
    (await createConversation({ phone_number: from, trigger: "inbound" }));
  if (!convo) {
    logger.error("Could not obtain a conversation for inbound SMS; dropping");
    return;
  }

  await insertTextMessage({ conversationId: convo.id, direction: "inbound", body });

  // 2. HELP: short identification reply (a reply to inbound → no STOP suffix needed).
  if (keyword === "help") {
    const { text } = await resolveEffectiveConfig();
    await sendSms({ conversation: convo, body: buildHelpReply(text.businessName) });
    return;
  }

  const [{ text, business }, lead, stages, leadFields, history] = await Promise.all([
    resolveEffectiveConfig(),
    findLeadByPhone(from),
    getTextStages(),
    getLeadFields(),
    getConversationMessages(convo.id),
  ]);

  const turn = await runSmsTurn({
    conversation: convo,
    lead,
    stages,
    leadFields,
    history: toChatTurns(history),
    model: text.model,
    agentName: business.agentName,
    businessName: text.businessName,
  });

  if (turn.optedOut) {
    await updateConversationStatus(convo.id, "opted_out");
    logger.info("Engine marked conversation opted out; no reply sent", {
      conversationId: convo.id,
    });
    return;
  }

  if (turn.reply.trim() !== "") {
    await sendSms({ conversation: convo, body: turn.reply });
  }

  if (turn.escalate) {
    await updateConversationStatus(convo.id, "escalated");
    await notifyEscalation({ phone: from, lead, businessName: text.businessName });
  }
}

/**
 * Bot-INITIATED opener (missed-call follow-up / web-lead outreach). Shared by both
 * triggers. Enforces: text bot enabled, the relevant sub-toggle, opt-out, and quiet
 * hours (8am–9pm bot timezone) BEFORE creating a conversation or sending. Sends the
 * opener with the mandatory business identification + "Reply STOP to opt out."
 * Returns whether an opener was sent (false when gated/blocked).
 */
async function sendOpener(input: {
  phone: string;
  trigger: TextTrigger;
  subToggleEnabled: boolean;
  leadName: string | null;
  now?: Date;
}): Promise<boolean> {
  const { phone, trigger, subToggleEnabled } = input;
  const { text, business } = await resolveEffectiveConfig();

  if (!text.enabled) {
    logger.info("SMS opener skipped: text bot disabled", { trigger });
    return false;
  }
  if (!subToggleEnabled) {
    logger.info("SMS opener skipped: sub-toggle disabled", { trigger });
    return false;
  }
  if (await isPhoneOptedOut(phone)) {
    logger.info("SMS opener skipped: number opted out", { trigger });
    return false;
  }
  if (!isWithinTextingWindow(input.now ?? new Date(), text.timezone)) {
    // Quiet hours: do not send now. Kept simple per spec — we skip rather than queue;
    // a later inbound reply (always allowed) resumes engagement.
    logger.info("SMS opener skipped: outside quiet-hours window", {
      trigger,
      timezone: text.timezone,
    });
    return false;
  }

  const stages = await getTextStages();
  const openerBody = buildOpenerText({
    stages,
    leadName: input.leadName,
    agentName: business.agentName,
    businessName: text.businessName,
  });

  const convo = await createConversation({ phone_number: phone, trigger });
  if (!convo) {
    logger.error("SMS opener aborted: could not create conversation", { trigger });
    return false;
  }

  const res = await sendSms({
    conversation: convo,
    body: openerBody,
    firstBotInitiated: true,
  });
  return res.sent;
}

/** Trigger 2: a voice call ended unserved — text the caller a follow-up opener. */
export async function sendMissedCallText(input: {
  phone: string;
  now?: Date;
}): Promise<boolean> {
  const { text } = await resolveEffectiveConfig();
  const lead = await findLeadByPhone(input.phone);
  return sendOpener({
    phone: input.phone,
    trigger: "missed_call",
    subToggleEnabled: text.missedCallEnabled,
    leadName: lead?.first_name ?? null,
    now: input.now,
  });
}

/** Trigger 3: authenticated web-lead outreach — text a new lead the opener. */
export async function sendWebLeadText(input: {
  phone: string;
  name?: string | null;
  now?: Date;
}): Promise<boolean> {
  const { text } = await resolveEffectiveConfig();
  return sendOpener({
    phone: input.phone,
    trigger: "web_lead",
    subToggleEnabled: text.webLeadEnabled,
    leadName: input.name ?? null,
    now: input.now,
  });
}

/**
 * Build the opener text. Prefers the first active opener stage's script_text
 * (placeholders filled), else a sensible default. Always ensures the business name
 * is present so the opener identifies who's texting (compliance). The STOP suffix
 * is added by sendSms(firstBotInitiated).
 */
export function buildOpenerText(input: {
  stages: TextStageRow[];
  leadName: string | null;
  agentName: string;
  businessName: string;
}): string {
  const name = input.leadName?.trim() ? input.leadName.trim() : "there";
  const opener = (input.stages ?? []).find((s) => s.stage_type === "opener");
  let body =
    opener && (opener.script_text ?? "").trim() !== ""
      ? (opener.script_text as string)
          .replace(/\(Client's Name\)/g, name)
          .replace(/\{name\}/g, name)
          .replace(/\(Agent Name\)/g, input.agentName)
          .trim()
      : `Hi ${name}, this is ${input.agentName} with ${input.businessName}. I saw you were looking into getting an SR22 filed — is now a good time to help you get that sorted?`;

  // Ensure the business is identified in the very first outbound message.
  if (!body.toLowerCase().includes(input.businessName.toLowerCase())) {
    body = `${input.businessName}: ${body}`;
  }
  return body;
}

/**
 * Notify the owner by SMS that a lead asked for a human. Sent from the texting
 * number to bot_config.escalation_number. Best-effort: logs and returns on any
 * missing-config / send failure (the conversation is already marked escalated).
 */
export async function notifyEscalation(input: {
  phone: string;
  lead: LeadRecord | null;
  businessName: string;
}): Promise<void> {
  const { text, twilio } = await resolveEffectiveConfig();
  const to = twilio.escalationNumber;
  if (!to || to.trim() === "") {
    logger.error("Cannot notify escalation: no escalation_number configured");
    return;
  }
  const from = text.number;
  if (!from) {
    logger.error("Cannot notify escalation: no text_number configured");
    return;
  }
  const client = await getTwilioClient();
  if (!client) {
    logger.error("Cannot notify escalation: no Twilio credentials");
    return;
  }
  const name = input.lead?.first_name?.trim() ? input.lead.first_name.trim() : "Unknown";
  const body = `Lead ${name} (${input.phone}) asked for a human over text — full convo in the dashboard.`;
  try {
    await client.messages.create({ from, to: to.trim(), body });
  } catch (err) {
    logger.error("Failed to send escalation notification SMS", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
