/**
 * Supabase-backed dynamic config loader (MULTI-TENANT).
 *
 * Every deployment of this bot is ONE tenant, identified by the required `BOT_ID`
 * env var (a uuid). All reads/writes are scoped to `bot_id = BOT_ID`; the bot
 * never touches other tenants' rows and never creates/alters tables (schema is
 * owned by the dashboard side).
 *
 * loadRemoteConfig() fetches this tenant's `bots` row, its `bot_config` row
 * (keyed by bot_id), and its `api_credentials` rows, caching the last successful
 * result in memory. It is cheap enough to call at the start of every call so
 * dashboard edits take effect on the next call without a redeploy.
 *
 * Config here is a *fallback* source: env vars always win (see
 * resolveEffectiveConfig in ../config). Any load failure is swallowed and logged
 * WITHOUT secret values so the bot still boots/answers on env vars alone.
 *
 * Uses the shared service-role client, which bypasses RLS.
 */

import { supabase } from "./supabase";
import { logger } from "../logger";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The tenant id for this deployment. Required and fail-fast — unlike the lenient
 * credential fallbacks, a missing/invalid BOT_ID is a fatal misconfiguration
 * because it determines which tenant's data we read and write.
 */
export const BOT_ID: string = (() => {
  const value = process.env.BOT_ID?.trim();
  if (!value) {
    throw new Error("Missing required environment variable: BOT_ID");
  }
  if (!UUID_RE.test(value)) {
    throw new Error("BOT_ID must be a valid uuid");
  }
  return value;
})();

/** The tenant row from `bots` (this IS the tenant table; it has no bot_id). */
export interface BotRow {
  id: string;
  name: string | null;
  slug: string | null;
  active: boolean | null;
  created_at: string | null;
}

/**
 * The `bot_config` row for this tenant (bot_config.bot_id = BOT_ID).
 * `compiled_instructions` (when non-empty) overrides the locally-built system
 * prompt; see ../ai/systemPrompt.ts.
 */
export interface BotConfigRow {
  id: number;
  bot_id: string;
  telephony_provider: string | null;
  tts_provider: string | null;
  tts_voice: string | null;
  tts_model: string | null;
  agent_name: string | null;
  brokerage_name: string | null;
  escalation_extension: string | null;
  bot_enabled: boolean | null;
  updated_at: string | null;
  compiled_instructions: string | null;
  realtime_voice: string | null;
  personality: string | null;
  /** This tenant's assigned RingCentral main number (dashboard-assigned). */
  rc_main_number: string | null;
  /** This tenant's assigned RingCentral extension (dashboard-assigned). */
  rc_extension: string | null;
  /** E.164 Twilio number for this bot's voice line (dashboard-assigned). */
  twilio_number: string | null;
  /** Active voice transport: 'ringcentral' (default) | 'twilio'. */
  voice_provider: string | null;
  /** E.164 number to dial when escalating to a human on the Twilio path. */
  escalation_number: string | null;
  /** Server-VAD sensitivity (0-1); higher = less sensitive to background/breath noise. */
  vad_threshold: number | null;
  /** Silence (ms) after speech before the model treats the caller's turn as ended. */
  vad_silence_ms: number | null;
  /** Audio (ms) kept before detected speech so word onsets aren't clipped. */
  vad_prefix_padding_ms: number | null;
  /** When false, the caller speaking does NOT interrupt/flush the bot's outgoing audio. */
  barge_in_enabled: boolean | null;
  /**
   * Realtime output speaking rate (OpenAI supports [0.25, 1.5]; default 1.0).
   * Nullable/absent-tolerant: the operator applies the ALTER TABLE separately, so
   * older schemas without this column resolve to the 1.0 default.
   */
  voice_speed: number | null;
  // ---- SMS texting bot (see migration 0009_texting_bot.sql) ----
  /** Master kill switch for the SMS bot; dashboard is source of truth, read fresh per message. */
  text_enabled: boolean | null;
  /** Dedicated Twilio SMS number for this bot (E.164), separate from the voice number. */
  text_number: string | null;
  /** RingCentral SMS number for this bot (E.164); null = RC texting off. See migration 0012. */
  rc_sms_number: string | null;
  /**
   * Chosen RingCentral extension id the bot sends texts AS (see migration 0016).
   * Null = the authenticated extension ('~'), the pre-PR-G behavior. Nullable/
   * absent-tolerant so older schemas without the column resolve to that default.
   */
  rc_sms_extension_id: string | null;
  /**
   * Display-only label of the RingCentral identity the bot is signed in as via
   * OAuth (see migration 0017), e.g. "Joal Ortiz — ext 499 (+1205...)". '' when
   * signed out. Non-secret; the refresh token itself lives in api_credentials.
   * Nullable/absent-tolerant so older schemas resolve to signed-out.
   */
  rc_signed_in_label: string | null;
  /** OpenAI chat model for SMS turns (default 'gpt-4o-mini'). */
  text_model: string | null;
  /** Business name used in SMS identification (falls back to agent_name). */
  business_name: string | null;
  /** Sub-toggle: send a follow-up text after a call the bot didn't serve. */
  missed_call_text_enabled: boolean | null;
  /** Sub-toggle: allow the authenticated web-lead outreach endpoint to text. */
  web_lead_text_enabled: boolean | null;
  /** IANA timezone for quiet-hours enforcement (default 'America/Los_Angeles'). */
  timezone: string | null;
  // ---- Bot roles + campaigns (see migration 0010_campaigns.sql) ----
  /**
   * Role gate: answer_calls | outbound_calls | answer_and_followup | texting.
   * Decides which pipelines are active for this tenant; read fresh per event.
   * Nullable/absent-tolerant so schemas without the column resolve to the default.
   */
  bot_role: string | null;
}

/** credentials keyed by provider name (e.g. "ringcentral", "openai-tts"). */
export type CredentialsMap = Record<string, Record<string, unknown>>;

export interface RemoteConfig {
  /** This tenant's `bots` row, or null when it does not exist / not yet loaded. */
  bot: BotRow | null;
  botConfig: BotConfigRow | null;
  credentials: CredentialsMap;
}

/** Last successfully loaded values. Starts empty so accessors are always safe. */
let cache: RemoteConfig = { bot: null, botConfig: null, credentials: {} };

/**
 * Whether we have EVER completed a successful load. Used to distinguish
 * "Supabase unreachable, can't verify" (fail-open — treat bot as enabled) from
 * "load succeeded and this tenant has no/inactive bots row" (disable the bot).
 */
let hasLoadedSuccessfully = false;

/**
 * Fetch this tenant's bots row, bot_config row, and api_credentials rows from
 * Supabase (all scoped by bot_id = BOT_ID). On success, overwrites the in-memory
 * cache and returns the fresh values. On any error, logs a warning (no secrets)
 * and returns the current (possibly empty / last-known-good) cache so callers can
 * proceed on env vars.
 */
export async function loadRemoteConfig(): Promise<RemoteConfig> {
  try {
    const [botRes, botConfigRes, credentialsRes] = await Promise.all([
      supabase.from("bots").select("*").eq("id", BOT_ID).maybeSingle(),
      supabase.from("bot_config").select("*").eq("bot_id", BOT_ID).maybeSingle(),
      supabase
        .from("api_credentials")
        .select("provider, credentials")
        .eq("bot_id", BOT_ID),
    ]);

    if (botRes.error) throw botRes.error;
    if (botConfigRes.error) throw botConfigRes.error;
    if (credentialsRes.error) throw credentialsRes.error;

    const credentials: CredentialsMap = {};
    for (const row of credentialsRes.data ?? []) {
      const provider = (row as { provider?: string }).provider;
      const creds = (row as { credentials?: Record<string, unknown> }).credentials;
      if (provider) {
        credentials[provider] = creds ?? {};
      }
    }

    cache = {
      bot: (botRes.data as BotRow | null) ?? null,
      botConfig: (botConfigRes.data as BotConfigRow | null) ?? null,
      credentials,
    };
    hasLoadedSuccessfully = true;
    return cache;
  } catch (err) {
    // Never log secret values — only the error message.
    logger.warn("Failed to load remote config from Supabase; using env vars only", {
      error: err instanceof Error ? err.message : String(err),
    });
    return cache;
  }
}

/** Accessor for the last successfully loaded remote config. */
export function getRemoteConfig(): RemoteConfig {
  return cache;
}

/**
 * Kill switch: whether the bot should answer calls / process messages.
 *
 * Fail-OPEN when we could never reach Supabase (can't verify → don't brick the
 * bot). Once we have a confirmed load, the bot is disabled when ANY of:
 *   (a) this tenant's `bots` row does not exist, or
 *   (b) that row's `active` is false, or
 *   (c) `bot_config.bot_enabled` is explicitly false.
 * Null/undefined `bot_enabled`/`active` are treated as enabled (only an explicit
 * false disables).
 */
export function isBotEnabled(): boolean {
  if (!hasLoadedSuccessfully) return true; // never verified → fail-open
  if (!cache.bot) return false; // confirmed: no tenant row
  if (cache.bot.active === false) return false; // tenant deactivated
  return cache.botConfig?.bot_enabled !== false;
}

/**
 * Read a single credential value from the cached credentials map (already scoped
 * to BOT_ID by loadRemoteConfig). Returns undefined when the provider/key is
 * absent or the value is not a string.
 */
export function getCredential(provider: string, key: string): string | undefined {
  const value = cache.credentials[provider]?.[key];
  return typeof value === "string" ? value : undefined;
}
