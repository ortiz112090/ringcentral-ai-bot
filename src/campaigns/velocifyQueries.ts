import { supabase } from "../db/supabase";
import { logger } from "../logger";
import { BOT_ID } from "../db/remoteConfig";
import type { CampaignRow, CampaignStatus } from "./campaignQueries";

/**
 * DB access for the Velocify report sync (multi-tenant, everything scoped by
 * bot_id). Mirrors campaignQueries.ts / smsQueries.ts conventions: every call is
 * failure-tolerant — a Supabase error is logged and swallowed so a bad query can
 * never crash the sync (runSync stays never-throwing). Reuses the existing
 * campaigns / campaign_contacts tables (migration 0010) and the bot_config columns
 * added by the Velocify migration.
 */

/** The auto-created text_outreach campaign the synced contacts are dropped onto. */
export const VELOCIFY_CAMPAIGN_NAME = "Velocify Report Sync";

/** Split an array into fixed-size chunks (keeps `.in()` filters + inserts bounded). */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The set of the given phones that ALREADY exist as a campaign_contact for this bot
 * (ANY campaign, ANY status) — a number we've queued/texted before. Batched via
 * chunked `.in()` lookups rather than per-row queries. Failure-tolerant: a chunk
 * error is logged and treated as "none known in this chunk" (the conversation lookup
 * and send-time compliance are the backstops).
 */
export async function getKnownCampaignContactPhones(
  phones: string[],
  chunkSize = 200,
  botId: string = BOT_ID
): Promise<Set<string>> {
  const known = new Set<string>();
  if (phones.length === 0) return known;
  for (const part of chunk(phones, chunkSize)) {
    const { data, error } = await supabase
      .from("campaign_contacts")
      .select("phone_number")
      .eq("bot_id", botId)
      .in("phone_number", part);
    if (error) {
      logger.error("Velocify: failed to look up known campaign_contacts", { error: error.message });
      continue;
    }
    for (const row of (data as Array<{ phone_number: string }>) ?? []) {
      if (row.phone_number) known.add(row.phone_number);
    }
  }
  return known;
}

/**
 * The set of the given phones that ALREADY have a text_conversations row for this bot
 * (any status) — a number the SMS pipeline has already touched. Batched + failure-
 * tolerant, same as getKnownCampaignContactPhones.
 */
export async function getKnownConversationPhones(
  phones: string[],
  chunkSize = 200,
  botId: string = BOT_ID
): Promise<Set<string>> {
  const known = new Set<string>();
  if (phones.length === 0) return known;
  for (const part of chunk(phones, chunkSize)) {
    const { data, error } = await supabase
      .from("text_conversations")
      .select("phone_number")
      .eq("bot_id", botId)
      .in("phone_number", part);
    if (error) {
      logger.error("Velocify: failed to look up known conversations", { error: error.message });
      continue;
    }
    for (const row of (data as Array<{ phone_number: string }>) ?? []) {
      if (row.phone_number) known.add(row.phone_number);
    }
  }
  return known;
}

/**
 * Find this bot's 'Velocify Report Sync' text_outreach campaign, creating it (status
 * running) when absent. When it already exists, re-activate it if the worker had
 * auto-completed it (otherwise newly synced contacts would be silently swallowed,
 * since the text-outreach worker only processes "running" campaigns) and apply a
 * changed pace_per_hour — both folded into a single scoped update. Returns the
 * campaign row, or null on error so the caller inserts nothing this run.
 */
export async function findOrCreateVelocifyCampaign(
  pacePerHour: number,
  botId: string = BOT_ID
): Promise<CampaignRow | null> {
  const { data: existing, error: readErr } = await supabase
    .from("campaigns")
    .select(
      "id, bot_id, name, campaign_type, status, pace_per_hour, dc_recording_id, send_delay_minutes"
    )
    .eq("bot_id", botId)
    .eq("campaign_type", "text_outreach")
    .eq("name", VELOCIFY_CAMPAIGN_NAME)
    .limit(1)
    .maybeSingle();
  if (readErr) {
    logger.error("Velocify: failed to look up campaign", { error: readErr.message });
    return null;
  }

  if (existing) {
    const row = existing as CampaignRow;
    const update: { pace_per_hour?: number; status?: CampaignStatus } = {};
    if (row.pace_per_hour !== pacePerHour) update.pace_per_hour = pacePerHour;
    if (row.status === "completed") update.status = "running";
    if (Object.keys(update).length > 0) {
      const { error: updErr } = await supabase
        .from("campaigns")
        .update(update)
        .eq("bot_id", botId)
        .eq("id", row.id);
      if (updErr) {
        logger.error("Velocify: failed to update campaign", { error: updErr.message });
      } else {
        if (update.pace_per_hour !== undefined) row.pace_per_hour = update.pace_per_hour;
        if (update.status !== undefined) row.status = update.status;
      }
    }
    return row;
  }

  const { data: created, error: insErr } = await supabase
    .from("campaigns")
    .insert({
      bot_id: botId,
      name: VELOCIFY_CAMPAIGN_NAME,
      campaign_type: "text_outreach",
      status: "running",
      pace_per_hour: pacePerHour,
    })
    .select(
      "id, bot_id, name, campaign_type, status, pace_per_hour, dc_recording_id, send_delay_minutes"
    )
    .maybeSingle();
  if (insErr) {
    logger.error("Velocify: failed to create campaign", { error: insErr.message });
    return null;
  }
  return (created as CampaignRow) ?? null;
}

/**
 * Insert the given contacts as PENDING campaign_contacts for the campaign, in chunks.
 * Returns the number of rows successfully inserted. Failure-tolerant: a chunk error is
 * logged and skipped so the rest still land.
 */
export async function insertPendingContacts(
  campaignId: string,
  contacts: Array<{ first_name: string | null; phone_number: string }>,
  chunkSize = 200,
  botId: string = BOT_ID
): Promise<number> {
  if (contacts.length === 0) return 0;
  let inserted = 0;
  for (const part of chunk(contacts, chunkSize)) {
    const rows = part.map((c) => ({
      bot_id: botId,
      campaign_id: campaignId,
      phone_number: c.phone_number,
      first_name: c.first_name,
      status: "pending",
    }));
    const { error } = await supabase.from("campaign_contacts").insert(rows);
    if (error) {
      logger.error("Velocify: failed to insert campaign_contacts chunk", { error: error.message });
      continue;
    }
    inserted += rows.length;
  }
  return inserted;
}

/**
 * Stamp bot_config.velocify_last_synced_at for this tenant after a successful sync.
 * Failure-tolerant: a write error is logged (the next tick simply re-evaluates the
 * interval against the older timestamp).
 */
export async function updateVelocifyLastSyncedAt(
  iso: string,
  botId: string = BOT_ID
): Promise<void> {
  const { error } = await supabase
    .from("bot_config")
    .update({ velocify_last_synced_at: iso })
    .eq("bot_id", botId);
  if (error) {
    logger.error("Velocify: failed to update velocify_last_synced_at", { error: error.message });
  }
}
