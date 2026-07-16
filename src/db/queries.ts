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

export async function createCallRecord(record: CallRecord): Promise<void> {
  const { error } = await supabase.from("calls").insert({
    bot_id: BOT_ID,
    call_id: record.call_id,
    caller_number: record.caller_number,
    started_at: record.started_at,
    transcript: record.transcript ?? [],
    realtime_session_id: record.realtime_session_id ?? null,
  });
  if (error) {
    logger.error("Failed to create call record", { callId: record.call_id, error: error.message });
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
