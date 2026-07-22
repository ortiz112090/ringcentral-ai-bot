import { supabase } from "../db/supabase";
import { logger } from "../logger";
import { BOT_ID } from "../db/remoteConfig";

/**
 * DB access for the SMS texting bot (multi-tenant, everything scoped by bot_id).
 * Mirrors src/db/queries.ts conventions: every write is failure-tolerant — a
 * Supabase error is logged and swallowed so a dropped row never crashes the SMS
 * flow. Tables: text_stages, text_conversations, text_messages (see migration
 * 0009_texting_bot.sql). The texting bot uses ONLY text_stages, never script_stages.
 */

export type TextConversationStatus =
  | "active"
  | "completed"
  | "escalated"
  | "opted_out"
  | "declined";

export type TextTrigger = "inbound" | "missed_call" | "web_lead";

export type TextDirection = "inbound" | "outbound";

/** Which provider a conversation lives on; decides the reply sender. */
export type TextChannel = "twilio" | "ringcentral";

/** A dashboard-authored SMS script stage (text_stages), same shape as script_stages. */
export interface TextStageRow {
  stage_key: string;
  stage_order: number | null;
  stage_type:
    | "opener"
    | "qualify"
    | "data_collection"
    | "quote"
    | "close"
    | "objection"
    | "fallback"
    | string;
  title: string | null;
  script_text: string | null;
}

/** A text_conversations row for this tenant. */
export interface TextConversationRow {
  id: string;
  bot_id: string;
  phone_number: string;
  status: TextConversationStatus;
  trigger: TextTrigger;
  /** Provider this thread lives on; replies go out this channel (default 'twilio'). */
  channel: TextChannel;
  captured_data: Record<string, unknown> | null;
  last_message_at: string | null;
  created_at: string | null;
}

/** A text_messages row. */
export interface TextMessageRow {
  direction: TextDirection;
  body: string;
  created_at: string | null;
}

/**
 * Read this bot's ACTIVE Text Flow stages ordered by stage_order, used to build the
 * SMS system prompt. Failure-tolerant: on any error returns an empty array so the
 * caller falls back to the hardcoded SMS script and the flow is never broken.
 */
export async function getTextStages(botId: string = BOT_ID): Promise<TextStageRow[]> {
  const { data, error } = await supabase
    .from("text_stages")
    .select("stage_key, stage_order, stage_type, title, script_text")
    .eq("bot_id", botId)
    .eq("active", true)
    .order("stage_order", { ascending: true });
  if (error) {
    logger.error("Failed to load text stages", { botId, error: error.message });
    return [];
  }
  return (data as TextStageRow[]) ?? [];
}

/** An ACTIVE text-outreach first-message template (text_outreach_templates). */
export interface TextOutreachTemplateRow {
  id: string;
  template_text: string;
}

/**
 * Read this bot's ACTIVE text-outreach templates (text_outreach_templates). The
 * outreach worker picks one uniformly at random per contact for the first message.
 * Failure-tolerant: on any error returns [] so the worker simply leaves contacts
 * pending this tick (an operator config gap, never a hard failure).
 */
export async function getActiveOutreachTemplates(
  botId: string = BOT_ID
): Promise<TextOutreachTemplateRow[]> {
  const { data, error } = await supabase
    .from("text_outreach_templates")
    .select("id, template_text")
    .eq("bot_id", botId)
    .eq("active", true);
  if (error) {
    logger.error("Failed to load text outreach templates", { botId, error: error.message });
    return [];
  }
  return (data as TextOutreachTemplateRow[]) ?? [];
}

/**
 * Find the most recent conversation for a phone number on this bot, or null. Used
 * to continue an existing thread (inbound) and to enforce opt-out before any
 * outbound send. Returns the newest row so a re-engaged lead resumes their thread.
 */
export async function findConversationByPhone(
  phone: string,
  botId: string = BOT_ID
): Promise<TextConversationRow | null> {
  const { data, error } = await supabase
    .from("text_conversations")
    .select("*")
    .eq("bot_id", botId)
    .eq("phone_number", phone)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.error("Failed to look up text conversation", { phone, error: error.message });
    return null;
  }
  return (data as TextConversationRow) ?? null;
}

/**
 * Create a new conversation row and return it. Used by the triggers (missed_call /
 * web_lead) and by the inbound webhook when no thread exists yet. Returns null on
 * error so callers can abort the send rather than text without a tracked thread.
 */
export async function createConversation(input: {
  phone_number: string;
  trigger: TextTrigger;
  status?: TextConversationStatus;
  channel?: TextChannel;
  captured_data?: Record<string, unknown>;
}): Promise<TextConversationRow | null> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("text_conversations")
    .insert({
      bot_id: BOT_ID,
      phone_number: input.phone_number,
      status: input.status ?? "active",
      trigger: input.trigger,
      // Default to the Twilio channel so pre-RC callers keep their behavior.
      channel: input.channel ?? "twilio",
      captured_data: input.captured_data ?? {},
      last_message_at: now,
      created_at: now,
    })
    .select("*")
    .maybeSingle();
  if (error) {
    logger.error("Failed to create text conversation", {
      phone: input.phone_number,
      error: error.message,
    });
    return null;
  }
  return (data as TextConversationRow) ?? null;
}

/**
 * Record one SMS message (inbound or outbound) and bump the conversation's
 * last_message_at. Failure-tolerant: logs and continues so a dropped message row
 * never blocks the reply.
 */
export async function insertTextMessage(input: {
  conversationId: string;
  direction: TextDirection;
  body: string;
  /** Upstream provider message id (RingCentral message-store id) for dedupe; null for Twilio. */
  providerMessageId?: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase.from("text_messages").insert({
    bot_id: BOT_ID,
    conversation_id: input.conversationId,
    direction: input.direction,
    body: input.body,
    provider_message_id: input.providerMessageId ?? null,
    created_at: now,
  });
  if (error) {
    logger.error("Failed to insert text message", {
      conversationId: input.conversationId,
      error: error.message,
    });
    return;
  }
  const { error: updErr } = await supabase
    .from("text_conversations")
    .update({ last_message_at: now })
    .eq("bot_id", BOT_ID)
    .eq("id", input.conversationId);
  if (updErr) {
    logger.error("Failed to bump conversation last_message_at", {
      conversationId: input.conversationId,
      error: updErr.message,
    });
  }
}

/**
 * Load a conversation's message history (oldest→newest), capped to the most recent
 * `limit` messages so a long thread never blows the model context. Failure-tolerant:
 * returns [] on error so the engine still replies (with no memory) rather than fail.
 */
export async function getConversationMessages(
  conversationId: string,
  limit = 40
): Promise<TextMessageRow[]> {
  const { data, error } = await supabase
    .from("text_messages")
    .select("direction, body, created_at")
    .eq("bot_id", BOT_ID)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    logger.error("Failed to load conversation messages", {
      conversationId,
      error: error.message,
    });
    return [];
  }
  // Fetched newest-first for the cap; return in chronological order for the model.
  return ((data as TextMessageRow[]) ?? []).reverse();
}

/**
 * True when a text_messages row for this bot already stores the given provider
 * message id. Used to dedupe inbound RingCentral deliveries (RC may redeliver the
 * same message-store event). Failure-tolerant: on a query error returns false so a
 * DB blip never permanently drops a real inbound message — the in-memory LRU in the
 * webhook is the fast first line, this is the durable second check.
 */
export async function hasProviderMessage(
  providerMessageId: string,
  botId: string = BOT_ID
): Promise<boolean> {
  const id = (providerMessageId ?? "").trim();
  if (id === "") return false;
  const { count, error } = await supabase
    .from("text_messages")
    .select("id", { count: "exact", head: true })
    .eq("bot_id", botId)
    .eq("provider_message_id", id);
  if (error) {
    logger.error("Failed to check provider_message_id dedupe; treating as new", {
      error: error.message,
    });
    return false;
  }
  return (count ?? 0) > 0;
}

/**
 * True when this phone has EVER opted out on this bot (any opted_out conversation).
 * Opt-out is sticky and per bot+number: once set we must never text it again, even
 * on a brand-new trigger. Failure-tolerant: on a query error returns true (fail
 * CLOSED) — a compliance check must never send just because the DB blipped.
 */
export async function isPhoneOptedOut(
  phone: string,
  botId: string = BOT_ID
): Promise<boolean> {
  const { count, error } = await supabase
    .from("text_conversations")
    .select("id", { count: "exact", head: true })
    .eq("bot_id", botId)
    .eq("phone_number", phone)
    .eq("status", "opted_out");
  if (error) {
    logger.error("Failed to check opt-out status; failing closed", {
      phone,
      error: error.message,
    });
    return true;
  }
  return (count ?? 0) > 0;
}

/**
 * True when this phone has EVER declined on this bot (any 'declined' conversation).
 * Like opt-out, a decline is terminal per bot+number: once the lead said they're not
 * interested (via the interest gate / mark_not_interested), the campaign worker must
 * not re-contact them. Failure-tolerant: on a query error returns true (fail CLOSED),
 * mirroring isPhoneOptedOut — a compliance check must never send on a DB blip.
 */
export async function isPhoneDeclined(
  phone: string,
  botId: string = BOT_ID
): Promise<boolean> {
  const { count, error } = await supabase
    .from("text_conversations")
    .select("id", { count: "exact", head: true })
    .eq("bot_id", botId)
    .eq("phone_number", phone)
    .eq("status", "declined");
  if (error) {
    logger.error("Failed to check declined status; failing closed", {
      phone,
      error: error.message,
    });
    return true;
  }
  return (count ?? 0) > 0;
}

/**
 * One synced RingCentral SMS sender option (rc_sms_options): an
 * (extension, SMS-capable phone number) pair the dashboard offers as a
 * "send as / from" choice. See migration 0016_rc_sender_choice.sql.
 */
export interface RcSmsOptionInput {
  extension_id: string;
  extension_name: string;
  extension_number: string;
  phone_number: string;
  sms_enabled: boolean;
}

/**
 * Replace this bot's rc_sms_options read-model rows: delete the bot's existing rows,
 * then bulk-insert the freshly-synced set. Called by the RC options poller only AFTER
 * a successful fetch, so a failed fetch never wipes the old rows. Failure-tolerant: a
 * delete error leaves the old rows in place (logged, no insert); an insert error is
 * logged. Never throws, so the never-throwing poller stays non-fatal.
 */
export async function replaceRcSmsOptions(
  options: RcSmsOptionInput[],
  botId: string = BOT_ID
): Promise<void> {
  const { error: delErr } = await supabase
    .from("rc_sms_options")
    .delete()
    .eq("bot_id", botId);
  if (delErr) {
    logger.error("Failed to clear rc_sms_options; leaving old rows in place", {
      botId,
      error: delErr.message,
    });
    return;
  }
  if (options.length === 0) return;
  const now = new Date().toISOString();
  const rows = options.map((o) => ({ bot_id: botId, ...o, synced_at: now }));
  const { error: insErr } = await supabase.from("rc_sms_options").insert(rows);
  if (insErr) {
    logger.error("Failed to insert rc_sms_options", { botId, error: insErr.message });
  }
}

/** Update a conversation's status (active/completed/escalated/opted_out). */
export async function updateConversationStatus(
  conversationId: string,
  status: TextConversationStatus
): Promise<void> {
  const { error } = await supabase
    .from("text_conversations")
    .update({ status })
    .eq("bot_id", BOT_ID)
    .eq("id", conversationId);
  if (error) {
    logger.error("Failed to update conversation status", {
      conversationId,
      status,
      error: error.message,
    });
  }
}

/**
 * Merge captured answers into text_conversations.captured_data (read-modify-write),
 * scoped to bot_id + conversation id. Existing keys are preserved; new/changed keys
 * overwrite. Mirrors mergeCapturedData for the voice path. Failure-tolerant.
 */
export async function mergeConversationCapturedData(
  conversationId: string,
  data: Record<string, unknown>
): Promise<void> {
  if (!data || Object.keys(data).length === 0) return;
  const { data: row, error } = await supabase
    .from("text_conversations")
    .select("captured_data")
    .eq("bot_id", BOT_ID)
    .eq("id", conversationId)
    .maybeSingle();
  if (error) {
    logger.error("Failed to read captured_data for merge", {
      conversationId,
      error: error.message,
    });
    return;
  }
  const current = (row?.captured_data as Record<string, unknown> | null) ?? {};
  const merged = { ...current, ...data };
  const { error: updErr } = await supabase
    .from("text_conversations")
    .update({ captured_data: merged })
    .eq("bot_id", BOT_ID)
    .eq("id", conversationId);
  if (updErr) {
    logger.error("Failed to merge conversation captured_data", {
      conversationId,
      error: updErr.message,
    });
  }
}
