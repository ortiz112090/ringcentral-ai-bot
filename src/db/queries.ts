import { supabase } from "./supabase";
import { logger } from "../logger";
import { BOT_ID } from "./remoteConfig";
import {
  CallOutcome,
  CallRecord,
  LeadRecord,
  TranscriptTurn,
} from "./types";

/**
 * All DB writes are wrapped so a Supabase failure never crashes call handling.
 * We log the error and continue — a dropped log row is far cheaper than a dropped call.
 */

/** Fresh per-call snapshot of this tenant's enabled/disabled state from `bots`. */
export interface BotActiveStatus {
  /** true when a `bots` row exists for this tenant (id = bot_id). */
  found: boolean;
  /** `bots.active`; null is treated as enabled (only an explicit false disables). */
  active: boolean | null;
  /** `bots.deleted_at`; non-null means the bot is trashed → disabled. */
  deleted_at: string | null;
}

/**
 * Read this tenant's enable/disable state straight from `bots` (id = bot_id),
 * bypassing the remoteConfig cache. The dashboard toggle and the trash system both
 * live on `bots.active`, so the call path must re-read it FRESH on every inbound
 * call. Returns the row snapshot on success (found=false when the row is missing),
 * or null ONLY on a query error so the caller can fail open (can't verify → don't
 * brick the bot; the downstream kill-switch still applies).
 */
export async function fetchBotActiveStatus(
  botId: string = BOT_ID
): Promise<BotActiveStatus | null> {
  const { data, error } = await supabase
    .from("bots")
    .select("active, deleted_at")
    .eq("id", botId)
    .maybeSingle();
  if (error) {
    logger.error("Failed to read bot active status", { botId, error: error.message });
    return null;
  }
  if (!data) return { found: false, active: null, deleted_at: null };
  const row = data as { active: boolean | null; deleted_at: string | null };
  return { found: true, active: row.active ?? null, deleted_at: row.deleted_at ?? null };
}

/**
 * Phase 1 of the two-phase call write: insert the row at CALL START with
 * ended_at left NULL so the dashboard shows a live (in-progress) call.
 *
 * Uses upsert with ignoreDuplicates on the call_id primary key so a retried or
 * duplicated webhook "call started" event never creates a second row AND never
 * clobbers an already-in-progress row (its transcript/started_at are preserved).
 */
export async function createCallRecord(record: CallRecord): Promise<void> {
  const row: Record<string, unknown> = {
    bot_id: BOT_ID,
    call_id: record.call_id,
    caller_number: record.caller_number,
    started_at: record.started_at,
    ended_at: null,
    transcript: record.transcript ?? [],
    realtime_session_id: record.realtime_session_id ?? null,
  };
  // Outbound calls set these on the phase-1 insert so the row links to the dialed
  // contact; inbound calls omit them and rely on the calls.direction column default
  // ('inbound'). Written only when provided so the ignoreDuplicates upsert on an
  // existing inbound row never flips its direction.
  if (record.direction) row.direction = record.direction;
  if (record.campaign_contact_id != null) row.campaign_contact_id = record.campaign_contact_id;
  const { error } = await supabase.from("calls").upsert(row, {
    onConflict: "call_id",
    ignoreDuplicates: true,
  });
  if (error) {
    logger.error("Failed to create call record", { callId: record.call_id, error: error.message });
  }
}

/**
 * Insert a single conversation turn into call_transcripts as it completes, so the
 * dashboard can stream the transcript live. turn_index is sequential per call
 * (0-based, matching the in-memory transcript array position). Failure-tolerant:
 * a dropped turn is logged and never interrupts the live call — the authoritative
 * full transcript is still written to calls.transcript at call end.
 */
export async function insertCallTranscriptTurn(turn: {
  callId: string;
  turnIndex: number;
  speaker: TranscriptTurn["role"];
  text: string;
}): Promise<void> {
  const { error } = await supabase.from("call_transcripts").insert({
    bot_id: BOT_ID,
    call_id: turn.callId,
    turn_index: turn.turnIndex,
    speaker: turn.speaker,
    text: turn.text,
  });
  if (error) {
    logger.error("Failed to insert transcript turn", {
      callId: turn.callId,
      turnIndex: turn.turnIndex,
      error: error.message,
    });
  }
}

/**
 * Safety net for "ghost live calls": if a call-end update never ran (process
 * crash/restart mid-call), its row stays ended_at NULL forever and the dashboard
 * shows it as perpetually live. On startup we close out this tenant's stale rows
 * — ended_at NULL and started_at older than the threshold — as 'abandoned'.
 */
export async function closeStaleLiveCalls(
  olderThanMs: number = 2 * 60 * 60 * 1000
): Promise<void> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const { data, error } = await supabase
    .from("calls")
    .update({ outcome: "abandoned", ended_at: new Date().toISOString() })
    .eq("bot_id", BOT_ID)
    .is("ended_at", null)
    .lt("started_at", cutoff)
    .select("call_id");
  if (error) {
    logger.error("Failed to close stale live calls", { error: error.message });
    return;
  }
  if (data && data.length > 0) {
    logger.info("Closed stale live calls on startup", { count: data.length });
  }
}

/**
 * Close a call row IF it is still live (ended_at NULL). Backstop for the Twilio
 * status callback: if the media WebSocket dies without a clean "stop", the row
 * would stay open forever. The `.is("ended_at", null)` guard means a clean
 * teardown that already finalized the outcome/ended_at is never overwritten by a
 * later status callback. Failure-tolerant: logs and continues.
 */
export async function closeCallIfLive(
  callId: string,
  outcome: CallOutcome
): Promise<void> {
  const { data, error } = await supabase
    .from("calls")
    .update({ outcome, ended_at: new Date().toISOString() })
    .eq("bot_id", BOT_ID)
    .eq("call_id", callId)
    .is("ended_at", null)
    .select("call_id");
  if (error) {
    logger.error("Failed to close live call from status callback", { callId, error: error.message });
    return;
  }
  if (data && data.length > 0) {
    logger.info("Closed live call from Twilio status callback", { callId, outcome });
  }
}

/**
 * Record the OpenAI Realtime session id on an existing call row (set once the realtime
 * WebSocket session is established). Failure-tolerant: logs and continues.
 */
export async function setRealtimeSessionId(
  callId: string,
  realtimeSessionId: string
): Promise<void> {
  const { error } = await supabase
    .from("calls")
    .update({ realtime_session_id: realtimeSessionId })
    .eq("bot_id", BOT_ID)
    .eq("call_id", callId);
  if (error) {
    logger.error("Failed to set realtime session id", { callId, error: error.message });
  }
}

export async function finalizeCallRecord(
  callId: string,
  fields: {
    outcome: CallOutcome;
    scriptStageReached?: string | null;
    transcript?: TranscriptTurn[];
    endedAt?: string;
  }
): Promise<void> {
  const update = {
    outcome: fields.outcome,
    script_stage_reached: fields.scriptStageReached ?? null,
    transcript: fields.transcript ?? undefined,
    ended_at: fields.endedAt ?? new Date().toISOString(),
  };

  // Backstop guard (mirrors closeCallIfLive): only finalize a row that is still
  // live (ended_at NULL). If two teardown paths race, the FIRST terminal write
  // wins and a later duplicate matches no rows instead of clobbering the outcome.
  const { data, error } = await supabase
    .from("calls")
    .update(update)
    .eq("bot_id", BOT_ID)
    .eq("call_id", callId)
    .is("ended_at", null)
    .select("call_id");
  if (error) {
    logger.error("Failed to finalize call record", { callId, error: error.message });
    return;
  }
  if (data && data.length > 0) {
    return; // finalized the live row — done
  }

  // The row was already finalized by a concurrent teardown. "abandoned" is the
  // weakest outcome and must NEVER overwrite a real terminal one, so bail out when
  // that's what we're writing. Any stronger outcome (escalated, closed_*, ...) is
  // allowed to upgrade a row the hangup path finalized first as 'abandoned'.
  if (fields.outcome === "abandoned") {
    return;
  }

  const { error: upgradeError } = await supabase
    .from("calls")
    .update(update)
    .eq("bot_id", BOT_ID)
    .eq("call_id", callId)
    .eq("outcome", "abandoned")
    .select("call_id");
  if (upgradeError) {
    logger.error("Failed to upgrade abandoned call record", { callId, error: upgradeError.message });
  }
}

/** A dashboard-configured lead-capture field (lead_fields table), scoped to a bot. */
export interface LeadFieldRow {
  field_key: string;
  label: string | null;
  description: string | null;
  field_type: "text" | "number" | "date" | "choice" | string;
  choices: string[] | null;
  required: boolean | null;
  sort_order: number | null;
}

/**
 * Read this bot's ACTIVE lead-capture fields ordered by sort_order, used to build
 * the capture_lead_info tool schema dynamically. Failure-tolerant: on any error
 * returns an empty array so the caller falls back to the hardcoded schema and the
 * call flow is never broken.
 */
export async function getLeadFields(botId: string = BOT_ID): Promise<LeadFieldRow[]> {
  const { data, error } = await supabase
    .from("lead_fields")
    .select("field_key, label, description, field_type, choices, required, sort_order")
    .eq("bot_id", botId)
    .eq("active", true)
    .order("sort_order", { ascending: true });
  if (error) {
    logger.error("Failed to load lead fields", { botId, error: error.message });
    return [];
  }
  return (data as LeadFieldRow[]) ?? [];
}

/**
 * Merge the model's captured answers into calls.captured_data (a JSONB object),
 * scoped to bot_id + call_id. Read-modify-write: existing keys are preserved and
 * new/changed keys overwrite. Failure-tolerant: logs and continues so a dropped
 * capture never interrupts the live call.
 */
export async function mergeCapturedData(
  callId: string,
  data: Record<string, unknown>
): Promise<void> {
  if (!data || Object.keys(data).length === 0) return;
  const { data: row, error } = await supabase
    .from("calls")
    .select("captured_data")
    .eq("bot_id", BOT_ID)
    .eq("call_id", callId)
    .maybeSingle();
  if (error) {
    logger.error("Failed to read captured_data for merge", { callId, error: error.message });
    return;
  }
  const current = (row?.captured_data as Record<string, unknown> | null) ?? {};
  const merged = { ...current, ...data };
  const { error: updateError } = await supabase
    .from("calls")
    .update({ captured_data: merged })
    .eq("bot_id", BOT_ID)
    .eq("call_id", callId);
  if (updateError) {
    logger.error("Failed to merge captured_data", { callId, error: updateError.message });
  }
}

/** A dashboard-authored script stage (script_stages table), scoped to a bot. */
export interface ScriptStageRow {
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

/** A dashboard-authored script constraint (script_constraints table), scoped to a bot. */
export interface ScriptConstraintRow {
  rule_text: string | null;
  severity: string | null;
}

/**
 * Read this bot's ACTIVE script stages ordered by stage_order, used to build the
 * live-call instructions from the dashboard "Training & Learning" script. Failure-
 * tolerant: on any error returns an empty array so the caller falls back to the
 * hardcoded script and the call flow is never broken (mirrors getLeadFields).
 */
export async function getScriptStages(botId: string = BOT_ID): Promise<ScriptStageRow[]> {
  const { data, error } = await supabase
    .from("script_stages")
    .select("stage_key, stage_order, stage_type, title, script_text")
    .eq("bot_id", botId)
    .eq("active", true)
    .order("stage_order", { ascending: true });
  if (error) {
    logger.error("Failed to load script stages", { botId, error: error.message });
    return [];
  }
  return (data as ScriptStageRow[]) ?? [];
}

/**
 * Read this bot's ACTIVE script constraints, rendered into the HARD RULES section
 * of the live-call instructions. Failure-tolerant: on any error returns an empty
 * array so the built-in hard rules still apply and the call flow is never broken.
 */
export async function getScriptConstraints(
  botId: string = BOT_ID
): Promise<ScriptConstraintRow[]> {
  const { data, error } = await supabase
    .from("script_constraints")
    .select("rule_text, severity")
    .eq("bot_id", botId)
    .eq("active", true);
  if (error) {
    logger.error("Failed to load script constraints", { botId, error: error.message });
    return [];
  }
  return (data as ScriptConstraintRow[]) ?? [];
}

/** A resolved webhook lead-destination (from lead_destinations.config). */
export interface WebhookDestination {
  url: string;
  secret?: string;
}

/**
 * Return this bot's enabled webhook lead-destination (destination_type='webhook')
 * with a non-empty config.url, or null when none is configured. Failure-tolerant:
 * logs and returns null so webhook dispatch is simply skipped on error.
 */
export async function getWebhookDestination(
  botId: string = BOT_ID
): Promise<WebhookDestination | null> {
  const { data, error } = await supabase
    .from("lead_destinations")
    .select("config")
    .eq("bot_id", botId)
    .eq("destination_type", "webhook")
    .eq("enabled", true)
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.error("Failed to load lead destination", { botId, error: error.message });
    return null;
  }
  const cfg = (data?.config as { url?: unknown; secret?: unknown } | null) ?? null;
  const url = typeof cfg?.url === "string" ? cfg.url.trim() : "";
  if (!url) return null;
  return {
    url,
    secret: typeof cfg?.secret === "string" && cfg.secret !== "" ? cfg.secret : undefined,
  };
}

/** Look up an existing lead by phone number so the bot can personalize the opener. */
export async function findLeadByPhone(phone: string): Promise<LeadRecord | null> {
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("bot_id", BOT_ID)
    .eq("phone_number", phone)
    .maybeSingle();
  if (error) {
    logger.error("Failed to look up lead", { phone, error: error.message });
    return null;
  }
  return (data as LeadRecord) ?? null;
}

/**
 * Insert or update a lead keyed by phone number. Used as the bot collects quote info.
 * Only writes fields that are provided (partial upsert).
 */
export async function upsertLead(lead: LeadRecord): Promise<void> {
  const payload: Record<string, unknown> = {
    bot_id: BOT_ID,
    phone_number: lead.phone_number,
    last_contacted_at: lead.last_contacted_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  // Copy only defined optional fields.
  const optionalKeys: (keyof LeadRecord)[] = [
    "first_name",
    "zip_code",
    "date_of_birth",
    "license_number",
    "license_state",
    "quote_amount_pif",
    "quote_amount_monthly",
    "carrier",
    "status",
  ];
  for (const key of optionalKeys) {
    if (lead[key] !== undefined && lead[key] !== null) {
      payload[key] = lead[key];
    }
  }

  const { error } = await supabase
    .from("leads")
    .upsert(payload, { onConflict: "phone_number" });
  if (error) {
    logger.error("Failed to upsert lead", { phone: lead.phone_number, error: error.message });
  }
}
