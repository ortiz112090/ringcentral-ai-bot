/**
 * Supabase-backed dynamic config loader.
 *
 * Loads the single `bot_config` row (id=1) and all `api_credentials` rows at
 * startup, caching the last successful result in memory. This is a *fallback*
 * source: env vars always win (see resolveEffectiveConfig in ../config). Any
 * failure here (missing table, network error, paused project) is swallowed and
 * logged WITHOUT secret values so the bot still boots on env vars alone.
 *
 * Uses the shared service-role client, which bypasses RLS.
 */

import { supabase } from "./supabase";
import { logger } from "../logger";

/**
 * The `bot_config` row (id=1). Columns mirror the live migrated schema.
 * `compiled_instructions` (when non-empty) overrides the locally-built system
 * prompt; see ../ai/systemPrompt.ts.
 */
export interface BotConfigRow {
  id: number;
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
}

/** credentials keyed by provider name (e.g. "ringcentral", "openai-tts"). */
export type CredentialsMap = Record<string, Record<string, unknown>>;

export interface RemoteConfig {
  botConfig: BotConfigRow | null;
  credentials: CredentialsMap;
}

/** Last successfully loaded values. Starts empty so accessors are always safe. */
let cache: RemoteConfig = { botConfig: null, credentials: {} };

/**
 * Fetch the bot_config row (id=1) and every api_credentials row from Supabase.
 * On success, updates the in-memory cache and returns the fresh values. On any
 * error, logs a warning (no secrets) and returns the current (possibly empty)
 * cache so callers can proceed on env vars.
 */
export async function loadRemoteConfig(): Promise<RemoteConfig> {
  try {
    const [botConfigRes, credentialsRes] = await Promise.all([
      supabase.from("bot_config").select("*").eq("id", 1).maybeSingle(),
      supabase.from("api_credentials").select("provider, credentials"),
    ]);

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
      botConfig: (botConfigRes.data as BotConfigRow | null) ?? null,
      credentials,
    };
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
 * Fail-open by design — only `bot_config.bot_enabled === false` disables the bot.
 * A null/undefined value (Supabase unreachable or row missing) is treated as
 * ENABLED so a brief Supabase outage can't brick inbound handling.
 */
export function isBotEnabled(): boolean {
  return cache.botConfig?.bot_enabled !== false;
}

/**
 * Read a single credential value from the cached credentials map.
 * Returns undefined when the provider/key is absent or the value is not a string.
 */
export function getCredential(provider: string, key: string): string | undefined {
  const value = cache.credentials[provider]?.[key];
  return typeof value === "string" ? value : undefined;
}
