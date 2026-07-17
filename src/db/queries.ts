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

/**
 * Phase 1 of the two-phase call write: insert the row at CALL START with
 * ended_at left NULL so the dashboard shows a live (in-progress) call.
 *
 * Uses upsert with ignoreDuplicates on the call_id primary key so a retried or
 * duplicated webhook "call started" event never creates a second row AND never
 * clobbers an already-in-progress row (its transcript/started_at are preserved).
 */
export async function createCallRecord(record: CallRecord): Promise<void> {
  const { error } = await supabase.from("calls").upsert(
    {
      bot_id: BOT_ID,
      call_id: record.call_id,
      caller_number: record.caller_number,
      started_at: record.started_at,
      ended_at: null,
      transcript: record.transcript ?? [],
      realtime_session_id: record.realtime_session_id ?? null,
    },
    { onConflict: "call_id", ignoreDuplicates: true }
  );
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
  const { error } = await supabase
    .from("calls")
    .update({
      outcome: fields.outcome,
      script_stage_reached: fields.scriptStageReached ?? null,
      transcript: fields.transcript ?? undefined,
      ended_at: fields.endedAt ?? new Date().toISOString(),
    })
    .eq("bot_id", BOT_ID)
    .eq("call_id", callId);
  if (error) {
    logger.error("Failed to finalize call record", { callId, error: error.message });
  }
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
