import { supabase } from "../db/supabase";
import { logger } from "../logger";
import { BOT_ID } from "../db/remoteConfig";

/**
 * DB access for the script-suggestion learning loop (multi-tenant, everything
 * scoped by bot_id). The analyzer (analyzer.ts) reads recent text conversations
 * + their messages and the ACTIVE text_stages, then writes PENDING rows into
 * script_suggestions. It NEVER touches text_stages/script_stages — approval and
 * apply happen in the dashboard. Every write is failure-tolerant: a Supabase
 * error is logged and swallowed so a dropped row never crashes the daily tick.
 * See migration 0013_script_suggestions.sql.
 */

/** The learning flow a suggestion targets. Voice is supported later; text now. */
export type SuggestionFlow = "text" | "voice";

/** The kind of change a suggestion proposes. */
export type SuggestionType = "reword" | "new_stage" | "new_faq";

/** One evidence item citing where in real conversations the signal came from. */
export interface SuggestionEvidence {
  conversation_id: string;
  snippet: string;
}

/** An ACTIVE text_stages row, including its id so a suggestion can target it. */
export interface ActiveStageRow {
  id: number;
  stage_key: string;
  stage_type: string;
  title: string | null;
  script_text: string | null;
}

/** A recent conversation loaded for analysis (lightweight header). */
export interface RecentConversationRow {
  id: string;
  status: string;
  trigger: string;
  created_at: string | null;
  last_message_at: string | null;
}

/** One message belonging to a conversation being analyzed. */
export interface AnalysisMessageRow {
  conversation_id: string;
  direction: "inbound" | "outbound";
  body: string;
  created_at: string | null;
}

/** A pending script_suggestions row to insert. */
export interface NewScriptSuggestion {
  flow: SuggestionFlow;
  stageId: number | null;
  suggestionType: SuggestionType;
  currentText: string | null;
  suggestedText: string;
  rationale: string;
  evidence: SuggestionEvidence[];
}

/**
 * Load this bot's ACTIVE text_stages (id + copy), ordered by stage_order, so the
 * analyzer can (a) show the model the current script and (b) map a suggestion back
 * to a real, still-active stage id. Failure-tolerant: returns [] on error.
 */
export async function getActiveTextStages(
  botId: string = BOT_ID
): Promise<ActiveStageRow[]> {
  const { data, error } = await supabase
    .from("text_stages")
    .select("id, stage_key, stage_type, title, script_text")
    .eq("bot_id", botId)
    .eq("active", true)
    .order("stage_order", { ascending: true });
  if (error) {
    logger.error("Failed to load active text stages for analysis", {
      botId,
      error: error.message,
    });
    return [];
  }
  return (data as ActiveStageRow[]) ?? [];
}

/**
 * Load the most-recent conversations updated within the last `sinceDays` days,
 * capped to `limit` (newest first). Failure-tolerant: returns [] on error.
 */
export async function getRecentConversations(input: {
  sinceDays: number;
  limit: number;
  botId?: string;
  now?: Date;
}): Promise<RecentConversationRow[]> {
  const botId = input.botId ?? BOT_ID;
  const now = input.now ?? new Date();
  const sinceIso = new Date(
    now.getTime() - input.sinceDays * 24 * 60 * 60 * 1000
  ).toISOString();
  const { data, error } = await supabase
    .from("text_conversations")
    .select("id, status, trigger, created_at, last_message_at")
    .eq("bot_id", botId)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(input.limit);
  if (error) {
    logger.error("Failed to load recent conversations for analysis", {
      botId,
      error: error.message,
    });
    return [];
  }
  return (data as RecentConversationRow[]) ?? [];
}

/**
 * Load messages (chronological) for a set of conversation ids, capped overall to
 * `limit` so a huge backlog can't blow the model context. Failure-tolerant:
 * returns [] on error. Returns [] immediately when there are no ids.
 */
export async function getMessagesForConversations(
  conversationIds: string[],
  limit = 500,
  botId: string = BOT_ID
): Promise<AnalysisMessageRow[]> {
  if (conversationIds.length === 0) return [];
  const { data, error } = await supabase
    .from("text_messages")
    .select("conversation_id, direction, body, created_at")
    .eq("bot_id", botId)
    .in("conversation_id", conversationIds)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) {
    logger.error("Failed to load messages for analysis", {
      botId,
      error: error.message,
    });
    return [];
  }
  return (data as AnalysisMessageRow[]) ?? [];
}

/**
 * The created_at of this bot's most recent suggestion for `flow`, or null when the
 * bot has never produced one. Used with countMessagesSince to implement the
 * "nothing new since last run" skip. Failure-tolerant: returns null on error (which
 * makes the caller treat the run as a first run and proceed — a spurious analysis is
 * cheaper than silently going stale).
 */
export async function getLastSuggestionAt(
  flow: SuggestionFlow,
  botId: string = BOT_ID
): Promise<string | null> {
  const { data, error } = await supabase
    .from("script_suggestions")
    .select("created_at")
    .eq("bot_id", botId)
    .eq("flow", flow)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.error("Failed to read last suggestion timestamp", {
      botId,
      flow,
      error: error.message,
    });
    return null;
  }
  return (data?.created_at as string | null) ?? null;
}

/**
 * Count text_messages created strictly after `sinceIso` (or all-time when null).
 * Used to skip a tick when fewer than N new messages have arrived since the last
 * suggestion. Failure-tolerant: returns 0 on error (which makes the caller skip —
 * we'd rather do nothing than burn an OpenAI call on a bad count).
 */
export async function countMessagesSince(
  sinceIso: string | null,
  botId: string = BOT_ID
): Promise<number> {
  let query = supabase
    .from("text_messages")
    .select("id", { count: "exact", head: true })
    .eq("bot_id", botId);
  if (sinceIso) query = query.gt("created_at", sinceIso);
  const { count, error } = await query;
  if (error) {
    logger.error("Failed to count new messages for analysis", {
      botId,
      error: error.message,
    });
    return 0;
  }
  return count ?? 0;
}

/**
 * Insert one PENDING suggestion. Returns true when a row was created, false when it
 * was a duplicate (blocked by the unique pending index, Postgres 23505) or on any
 * other error. Duplicates are logged at debug level and silently skipped — a daily
 * re-run re-proposing the same wording is expected, not an error.
 */
export async function insertScriptSuggestion(
  s: NewScriptSuggestion,
  botId: string = BOT_ID
): Promise<boolean> {
  const { error } = await supabase.from("script_suggestions").insert({
    bot_id: botId,
    flow: s.flow,
    stage_id: s.stageId,
    suggestion_type: s.suggestionType,
    current_text: s.currentText,
    suggested_text: s.suggestedText,
    rationale: s.rationale,
    evidence: s.evidence,
    status: "pending",
    created_at: new Date().toISOString(),
  });
  if (error) {
    // 23505 = unique_violation → an identical pending suggestion already exists.
    if ((error as { code?: string }).code === "23505") {
      logger.debug("Skipping duplicate pending suggestion", {
        botId,
        flow: s.flow,
        stageId: s.stageId,
        suggestionType: s.suggestionType,
      });
      return false;
    }
    logger.error("Failed to insert script suggestion", {
      botId,
      flow: s.flow,
      error: error.message,
    });
    return false;
  }
  return true;
}
