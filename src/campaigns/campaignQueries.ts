import { supabase } from "../db/supabase";
import { logger } from "../logger";
import { BOT_ID } from "../db/remoteConfig";

/**
 * DB access for campaigns + campaign_contacts (multi-tenant, everything scoped by
 * bot_id). Mirrors src/db/queries.ts / smsQueries.ts conventions: every call is
 * failure-tolerant — a Supabase error is logged and swallowed so one bad query
 * never kills a worker tick. Tables live in migration 0010_campaigns.sql.
 */

export type CampaignType = "outbound_calls" | "voicemail_drops" | "text_outreach";
export type CampaignStatus = "draft" | "running" | "paused" | "completed";
export type ContactStatus =
  | "pending"
  | "processing"
  | "sent"
  | "completed"
  | "failed"
  | "skipped";

export interface CampaignRow {
  id: string;
  bot_id: string;
  name: string;
  campaign_type: CampaignType;
  status: CampaignStatus;
  pace_per_hour: number;
  dc_recording_id: string | null;
  send_delay_minutes: number | null;
}

export interface CampaignContactRow {
  id: number;
  bot_id: string;
  campaign_id: string;
  phone_number: string;
  first_name: string | null;
  last_name: string | null;
  data: Record<string, unknown> | null;
  status: ContactStatus;
  outcome: string | null;
}

/** Outcome text is stored in a plain text column; keep it bounded so a huge provider
 *  body can never blow up the row. */
const MAX_OUTCOME_LEN = 500;

/** Truncate an outcome/reason string to a DB-safe length. */
export function truncateOutcome(value: string): string {
  const trimmed = (value ?? "").trim();
  return trimmed.length > MAX_OUTCOME_LEN ? trimmed.slice(0, MAX_OUTCOME_LEN) : trimmed;
}

/**
 * All RUNNING campaigns of a given type for this tenant. Failure-tolerant: returns
 * [] on error so the worker simply does nothing this tick.
 */
export async function getRunningCampaigns(
  campaignType: CampaignType,
  botId: string = BOT_ID
): Promise<CampaignRow[]> {
  const { data, error } = await supabase
    .from("campaigns")
    .select(
      "id, bot_id, name, campaign_type, status, pace_per_hour, dc_recording_id, send_delay_minutes"
    )
    .eq("bot_id", botId)
    .eq("campaign_type", campaignType)
    .eq("status", "running");
  if (error) {
    logger.error("Failed to load running campaigns", { campaignType, error: error.message });
    return [];
  }
  return (data as CampaignRow[]) ?? [];
}

/** Count pending contacts for a campaign (used to decide when it's completed). */
export async function countPendingContacts(campaignId: string): Promise<number> {
  const { count, error } = await supabase
    .from("campaign_contacts")
    .select("id", { count: "exact", head: true })
    .eq("bot_id", BOT_ID)
    .eq("campaign_id", campaignId)
    .eq("status", "pending");
  if (error) {
    logger.error("Failed to count pending contacts", { campaignId, error: error.message });
    return 0;
  }
  return count ?? 0;
}

/**
 * Newest attempt time among a campaign's contacts, where an "attempt" is any contact
 * in a terminal-ish attempted state (sent / skipped / failed — opt-out 'skipped'
 * counts, keeping send-delay spacing honest). Returns null when there are no attempts
 * yet (or on error — failure-tolerant, so the caller simply treats it as "no attempts"
 * and the tick stays never-throwing). Campaign- and bot-scoped.
 */
export async function getNewestAttemptedAt(
  campaignId: string,
  botId: string = BOT_ID
): Promise<Date | null> {
  const { data, error } = await supabase
    .from("campaign_contacts")
    .select("attempted_at")
    .eq("bot_id", botId)
    .eq("campaign_id", campaignId)
    .in("status", ["sent", "skipped", "failed"])
    .not("attempted_at", "is", null)
    .order("attempted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.error("Failed to read newest attempted_at", { campaignId, error: error.message });
    return null;
  }
  const ts = (data as { attempted_at: string | null } | null)?.attempted_at ?? null;
  return ts ? new Date(ts) : null;
}

/**
 * Claim up to `limit` pending contacts for a campaign: read the oldest pending rows
 * then flip them to 'processing' so a subsequent tick can't grab the same rows.
 * Returns the claimed rows (already marked processing). Failure-tolerant: returns []
 * on any error.
 */
export async function claimPendingContacts(
  campaignId: string,
  limit: number
): Promise<CampaignContactRow[]> {
  if (limit <= 0) return [];
  const { data, error } = await supabase
    .from("campaign_contacts")
    .select("id, bot_id, campaign_id, phone_number, first_name, last_name, data, status, outcome")
    .eq("bot_id", BOT_ID)
    .eq("campaign_id", campaignId)
    .eq("status", "pending")
    .order("id", { ascending: true })
    .limit(limit);
  if (error) {
    logger.error("Failed to read pending contacts", { campaignId, error: error.message });
    return [];
  }
  const rows = (data as CampaignContactRow[]) ?? [];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const { error: updErr } = await supabase
    .from("campaign_contacts")
    .update({ status: "processing" })
    .eq("bot_id", BOT_ID)
    .in("id", ids);
  if (updErr) {
    logger.error("Failed to mark contacts processing", { campaignId, error: updErr.message });
    return [];
  }
  return rows.map((r) => ({ ...r, status: "processing" as ContactStatus }));
}

/**
 * Set a contact's terminal status + outcome, stamping attempted_at now. Used for
 * sent/failed/skipped/completed transitions. Failure-tolerant.
 */
export async function setContactStatus(
  contactId: number,
  status: ContactStatus,
  outcome?: string | null
): Promise<void> {
  const patch: Record<string, unknown> = {
    status,
    attempted_at: new Date().toISOString(),
  };
  if (outcome !== undefined) patch.outcome = outcome === null ? null : truncateOutcome(outcome);
  const { error } = await supabase
    .from("campaign_contacts")
    .update(patch)
    .eq("bot_id", BOT_ID)
    .eq("id", contactId);
  if (error) {
    logger.error("Failed to update contact status", { contactId, status, error: error.message });
  }
}

/**
 * Finalize an outbound-call contact from the Twilio status callback: set its
 * terminal status + outcome, stamp attempted_at, and record the Twilio Call SID in
 * data.call_sid (merged, so any CSV-provided data is preserved). This is the
 * outbound-calling analogue of setContactStatus but additionally persists the SID so
 * the dialed contact links back to its Twilio call. Failure-tolerant.
 */
export async function setContactCallOutcome(
  contactId: number,
  status: ContactStatus,
  outcome: string,
  callSid: string | null
): Promise<void> {
  // Read-modify-write the jsonb data column so we merge the SID without dropping any
  // dashboard/CSV-provided fields. A read error just means we skip the SID merge.
  let data: Record<string, unknown> | undefined;
  if (callSid) {
    const { data: row, error: readErr } = await supabase
      .from("campaign_contacts")
      .select("data")
      .eq("bot_id", BOT_ID)
      .eq("id", contactId)
      .maybeSingle();
    if (readErr) {
      logger.warn("Failed to read contact data before call-outcome write", {
        contactId,
        error: readErr.message,
      });
    } else {
      const current = (row?.data as Record<string, unknown> | null) ?? {};
      data = { ...current, call_sid: callSid };
    }
  }

  const patch: Record<string, unknown> = {
    status,
    outcome: truncateOutcome(outcome),
    attempted_at: new Date().toISOString(),
  };
  if (data !== undefined) patch.data = data;

  const { error } = await supabase
    .from("campaign_contacts")
    .update(patch)
    .eq("bot_id", BOT_ID)
    .eq("id", contactId);
  if (error) {
    logger.error("Failed to set contact call outcome", { contactId, status, error: error.message });
  }
}

/** Mark a campaign completed (no pending contacts remain). Failure-tolerant. */
export async function completeCampaign(campaignId: string): Promise<void> {
  const { error } = await supabase
    .from("campaigns")
    .update({ status: "completed" })
    .eq("bot_id", BOT_ID)
    .eq("id", campaignId);
  if (error) {
    logger.error("Failed to complete campaign", { campaignId, error: error.message });
  }
}

/**
 * Look up a contact by its numeric id (the Drop Cowboy foreign_id is String(id)),
 * scoped to this tenant. Returns null when absent / on error so the status webhook
 * can no-op an unknown foreign_id.
 */
export async function findContactById(contactId: number): Promise<CampaignContactRow | null> {
  if (!Number.isFinite(contactId)) return null;
  const { data, error } = await supabase
    .from("campaign_contacts")
    .select("id, bot_id, campaign_id, phone_number, first_name, last_name, data, status, outcome")
    .eq("bot_id", BOT_ID)
    .eq("id", contactId)
    .maybeSingle();
  if (error) {
    logger.error("Failed to look up campaign contact", { contactId, error: error.message });
    return null;
  }
  return (data as CampaignContactRow) ?? null;
}
