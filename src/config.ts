/**
 * Central config loader. Reads all secrets/settings from environment variables.
 *
 * `config` (below) is the ENV-VAR BASELINE. SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY are truly required and fail fast — without them we
 * can't even reach Supabase to load anything else. The RingCentral/OpenAI
 * credentials and business fields are read leniently here because they can also
 * come from Supabase; the env-first merge happens in resolveEffectiveConfig().
 */

// Type-only import: erased at compile time, so it can't create a runtime import
// cycle (config -> remoteConfig -> supabase -> config). The runtime helpers are
// required lazily inside resolveEffectiveConfig() instead.
import type { BotConfigRow } from "./db/remoteConfig";
import { logger } from "./logger";

/**
 * The original/primary tenant ("Insurance Express"). ONLY this bot is allowed to
 * fall back to plain environment-variable credentials when a Supabase-sourced
 * credential is missing. Every other BOT_ID must source credentials from
 * Supabase exclusively — see resolveCredential() below.
 */
export const PRIMARY_BOT_ID = "00000000-0000-0000-0000-000000000001";

/** Current tenant id (unset/blank on the primary's legacy deploy). */
export const BOT_ID = envValue("BOT_ID");

/** True only for the primary tenant; gates env-var credential fallback. */
export const IS_PRIMARY_BOT = BOT_ID === PRIMARY_BOT_ID;

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

/** Raw env value, trimmed, or undefined when unset/blank. */
function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : undefined;
}

/** Env value wins; otherwise the (trimmed, non-empty) Supabase value; else undefined. */
function envFirst(
  name: string,
  remoteValue: string | null | undefined
): string | undefined {
  const env = envValue(name);
  if (env !== undefined) return env;
  return remoteValue && remoteValue.trim() !== "" ? remoteValue : undefined;
}

/**
 * Credential resolver with per-tenant isolation.
 *
 * Primary bot (BOT_ID === PRIMARY_BOT_ID): env-first behavior is UNCHANGED — env
 * wins, otherwise the Supabase value. This preserves the original single-bot
 * deploy that carries its secrets in env vars.
 *
 * Any other (non-primary) bot: env-var fallback is DISABLED. The credential must
 * come from Supabase (getCredential). If the Supabase value is missing we return
 * undefined and warn (no secret values) rather than leaking the primary deploy's
 * shared env-var credentials into a different tenant.
 *
 * `label` names the provider/key for the warning only — never a secret value.
 */
function resolveCredential(
  name: string,
  remoteValue: string | null | undefined,
  label: string
): string | undefined {
  if (IS_PRIMARY_BOT) {
    return envFirst(name, remoteValue);
  }
  const remote = remoteValue && remoteValue.trim() !== "" ? remoteValue : undefined;
  if (remote === undefined) {
    logger.warn(
      "Non-primary bot has no Supabase credential; env-var fallback is disabled for non-primary tenants",
      { botId: BOT_ID ?? null, credential: label }
    );
  }
  return remote;
}

export const config = {
  port: parseInt(optional("PORT", "3000"), 10),
  publicBaseUrl: optional("PUBLIC_BASE_URL", ""),

  // NOTE: RingCentral/OpenAI credentials are read leniently (optional, default "")
  // rather than fail-fast, because they may instead be supplied by Supabase and
  // merged env-first in resolveEffectiveConfig(). Only SUPABASE_URL and
  // SUPABASE_SERVICE_ROLE_KEY remain required — they're needed to reach Supabase.
  ringcentral: {
    clientId: optional("RINGCENTRAL_CLIENT_ID", ""),
    clientSecret: optional("RINGCENTRAL_CLIENT_SECRET", ""),
    serverUrl: optional("RINGCENTRAL_SERVER_URL", "https://platform.ringcentral.com"),
    jwt: optional("RINGCENTRAL_JWT", ""),
    escalationExtension: optional("ESCALATION_QUEUE_EXTENSION", ""),
    webhookVerificationToken: optional("RINGCENTRAL_WEBHOOK_VERIFICATION_TOKEN", ""),
  },

  openai: {
    apiKey: optional("OPENAI_API_KEY", ""),
    // Chat model used for non-realtime text tasks (SMS script turns + learning
    // lesson extraction). Replaces the retired Anthropic/Claude usage.
    chatModel: optional("OPENAI_CHAT_MODEL", "gpt-4o"),
    sttModel: optional("OPENAI_STT_MODEL", "gpt-4o-transcribe"),
    ttsModel: optional("OPENAI_TTS_MODEL", "gpt-4o-mini-tts"),
    ttsVoice: optional("OPENAI_TTS_VOICE", "alloy"),
    embeddingModel: optional("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"),
    // ---- Realtime (speech-to-speech) voice pipeline ----
    // Current stable/preview realtime model name. Update this single constant when
    // OpenAI promotes a newer realtime model to GA.
    realtimeModel: optional("OPENAI_REALTIME_MODEL", "gpt-4o-realtime-preview"),
    realtimeVoice: optional("OPENAI_REALTIME_VOICE", "alloy"),
    // Audio codec exchanged with the Realtime API. "g711_ulaw" (mu-law 8kHz) is
    // telephony-native and matches typical PSTN/RingCentral media, avoiding
    // resampling. "pcm16" (24kHz) is the higher-fidelity alternative.
    realtimeAudioFormat: optional("OPENAI_REALTIME_AUDIO_FORMAT", "g711_ulaw"),
  },

  supabase: {
    url: required("SUPABASE_URL"),
    serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  },

  business: {
    agentName: optional("AGENT_NAME", "Alex"),
    brokerageName: optional("BROKERAGE_NAME", "our brokerage"),
  },

  learning: {
    // When true, generate embeddings and use pgvector similarity search for retrieval.
    // When false (default), fall back to simple category-based lookup — no pgvector needed.
    usePgvector: optional("LEARNING_USE_PGVECTOR", "false").toLowerCase() === "true",
    // How many approved lessons to inject into the live prompt per call.
    retrievalLimit: parseInt(optional("LEARNING_RETRIEVAL_LIMIT", "3"), 10),
  },
};

export type AppConfig = typeof config;

/**
 * Effective (merged) config the app should use at runtime. For each field env
 * wins if set; otherwise the value loaded from Supabase (bot_config /
 * api_credentials) is used; otherwise a safe default. See remoteConfig.ts.
 */
export interface EffectiveConfig {
  ringcentral: {
    clientId: string | undefined;
    clientSecret: string | undefined;
    serverUrl: string;
    jwt: string | undefined;
    escalationExtension: string | undefined;
  };
  openai: {
    apiKey: string | undefined;
  };
  business: {
    agentName: string;
    brokerageName: string;
  };
  realtimeVoice: string;
  escalationExtension: string | undefined;
}

/**
 * Merge the env-var baseline with the Supabase-loaded config, ENV-FIRST.
 *
 * Reads the last successfully cached remote config (warmed at startup by
 * loadRemoteConfig() in index.ts) — it does not hit the network itself, so it's
 * cheap to call per request. RingCentral/OpenAI credentials and the
 * agentName/brokerageName/realtimeVoice/escalationExtension fields fall back to
 * Supabase only when the corresponding env var is unset.
 */
export async function resolveEffectiveConfig(): Promise<EffectiveConfig> {
  // Lazy require to avoid a module-load import cycle (see import note above).
  const {
    getRemoteConfig,
    getCredential,
  } = require("./db/remoteConfig") as typeof import("./db/remoteConfig");

  const botConfig: BotConfigRow | null = getRemoteConfig().botConfig;

  return {
    ringcentral: {
      // Secrets: env fallback only for the primary bot (see resolveCredential).
      clientId: resolveCredential(
        "RINGCENTRAL_CLIENT_ID",
        getCredential("ringcentral", "client_id"),
        "ringcentral.client_id"
      ),
      clientSecret: resolveCredential(
        "RINGCENTRAL_CLIENT_SECRET",
        getCredential("ringcentral", "client_secret"),
        "ringcentral.client_secret"
      ),
      // Non-secret endpoint with a public default: keep env-first for all bots.
      serverUrl:
        envFirst("RINGCENTRAL_SERVER_URL", getCredential("ringcentral", "server_url")) ??
        "https://platform.ringcentral.com",
      jwt: resolveCredential(
        "RINGCENTRAL_JWT",
        getCredential("ringcentral", "jwt"),
        "ringcentral.jwt"
      ),
      escalationExtension: envFirst(
        "ESCALATION_QUEUE_EXTENSION",
        botConfig?.escalation_extension
      ),
    },
    openai: {
      apiKey: resolveCredential(
        "OPENAI_API_KEY",
        getCredential("openai-tts", "api_key"),
        "openai.api_key"
      ),
    },
    business: {
      // Tenant identity: non-primary bots must not inherit the primary deploy's
      // env-var name/brokerage — resolve from Supabase only, else safe default.
      agentName: resolveCredential("AGENT_NAME", botConfig?.agent_name, "business.agent_name") ?? "Alex",
      brokerageName:
        resolveCredential("BROKERAGE_NAME", botConfig?.brokerage_name, "business.brokerage_name") ??
        "our brokerage",
    },
    realtimeVoice:
      envFirst("OPENAI_REALTIME_VOICE", botConfig?.realtime_voice) ?? "alloy",
    escalationExtension: envFirst("ESCALATION_QUEUE_EXTENSION", botConfig?.escalation_extension),
  };
}
