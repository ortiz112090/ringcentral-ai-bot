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
 * The primary/default bot tenant. Only this tenant is allowed to fall back to
 * plain env vars for credential fields; every other tenant must source its
 * credentials exclusively from Supabase (see resolveEffectiveConfig).
 */
const PRIMARY_BOT_ID = "00000000-0000-0000-0000-000000000001";

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

  // Twilio voice path. account_sid/auth_token are credentials (api_credentials
  // provider "twilio"); env vars here are the fallback for the primary bot only,
  // resolved env-first in resolveEffectiveConfig(). The number/voice_provider/
  // escalation_number live in bot_config (per-tenant DB columns).
  twilio: {
    accountSid: optional("TWILIO_ACCOUNT_SID", ""),
    authToken: optional("TWILIO_AUTH_TOKEN", ""),
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
    // GA realtime model name. The old "gpt-4o-realtime-preview" was retired with
    // the Realtime Beta interface on 2026-05-12; GA uses "gpt-realtime-2.1".
    realtimeModel: optional("OPENAI_REALTIME_MODEL", "gpt-realtime-2.1"),
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
  twilio: {
    accountSid: string | undefined;
    authToken: string | undefined;
    /** E.164 Twilio number that answers this tenant's voice line. */
    number: string | undefined;
    /** 'ringcentral' (default) | 'twilio'. */
    voiceProvider: string;
    /** E.164 number to <Dial> when escalating a Twilio call to a human. */
    escalationNumber: string | undefined;
  };
  business: {
    agentName: string;
    brokerageName: string;
  };
  realtimeVoice: string;
  escalationExtension: string | undefined;
}

/** Trimmed PUBLIC_BASE_URL with any trailing slash removed, or "" when unset. */
function publicBase(): string {
  return config.publicBaseUrl.trim().replace(/\/$/, "");
}

/**
 * Derive the per-call public WebSocket URL Twilio Media Streams should connect
 * back to, from PUBLIC_BASE_URL. "https://host" → "wss://host/media/{callSid}";
 * an http base maps to ws. The path is now per-call (/media/{callSid}) per the
 * Twilio-native rebuild spec — the media endpoint (attached in index.ts) matches
 * this prefix and the per-call HMAC stream token is still passed as a <Parameter>.
 * Returns "" when PUBLIC_BASE_URL is unset so callers can detect the
 * misconfiguration and fail closed.
 */
export function mediaStreamWssUrl(callSid: string): string {
  const base = publicBase();
  if (!base || !callSid) return "";
  try {
    const url = new URL(base);
    const scheme = url.protocol === "http:" ? "ws:" : "wss:";
    return `${scheme}//${url.host}/media/${encodeURIComponent(callSid)}`;
  } catch {
    return "";
  }
}

/**
 * Public URL Twilio POSTs inbound-call params to (the voice webhook). Used both
 * for X-Twilio-Signature validation and for auto-provisioning the number's
 * VoiceUrl. Returns "" when PUBLIC_BASE_URL is unset.
 */
export function twilioVoiceWebhookUrl(): string {
  const base = publicBase();
  return base ? `${base}/webhooks/twilio/voice` : "";
}

/**
 * Public URL Twilio POSTs call status callbacks to (event 'completed' at
 * minimum), so a call row still closes even if the media WebSocket dies without a
 * clean "stop". Set on the number config during provisioning. Returns "" when
 * PUBLIC_BASE_URL is unset.
 */
export function twilioStatusCallbackUrl(): string {
  const base = publicBase();
  return base ? `${base}/webhooks/twilio/status` : "";
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
    BOT_ID,
  } = require("./db/remoteConfig") as typeof import("./db/remoteConfig");

  const botConfig: BotConfigRow | null = getRemoteConfig().botConfig;

  // Credential isolation: only the primary tenant may fall back to plain env vars
  // for credentials. For any other BOT_ID we ignore env vars entirely for these
  // fields and treat a missing Supabase value as genuinely absent, so one tenant's
  // deployment can never silently inherit another's env-provided secrets.
  const isPrimaryBot = BOT_ID === PRIMARY_BOT_ID;

  /**
   * Env-first merge for a CREDENTIAL field. Primary bot: identical to envFirst.
   * Non-primary bot: env vars are disabled — return only the (trimmed, non-empty)
   * Supabase value, and warn (no secret values) when env fallback was suppressed.
   */
  const credentialFirst = (
    envName: string,
    remoteValue: string | null | undefined
  ): string | undefined => {
    if (isPrimaryBot) return envFirst(envName, remoteValue);
    const remote = remoteValue && remoteValue.trim() !== "" ? remoteValue : undefined;
    if (remote === undefined && envValue(envName) !== undefined) {
      logger.warn(
        "Env credential fallback disabled for non-primary tenant; treating credential as absent",
        { botId: BOT_ID, field: envName }
      );
    }
    return remote;
  };

  return {
    ringcentral: {
      clientId: credentialFirst("RINGCENTRAL_CLIENT_ID", getCredential("ringcentral", "client_id")),
      clientSecret: credentialFirst(
        "RINGCENTRAL_CLIENT_SECRET",
        getCredential("ringcentral", "client_secret")
      ),
      serverUrl:
        envFirst("RINGCENTRAL_SERVER_URL", getCredential("ringcentral", "server_url")) ??
        "https://platform.ringcentral.com",
      jwt: credentialFirst("RINGCENTRAL_JWT", getCredential("ringcentral", "jwt")),
      escalationExtension: envFirst(
        "ESCALATION_QUEUE_EXTENSION",
        botConfig?.escalation_extension
      ),
    },
    openai: {
      apiKey: credentialFirst("OPENAI_API_KEY", getCredential("openai-tts", "api_key")),
    },
    twilio: {
      // Credentials: DB (api_credentials provider "twilio") first, env only for
      // the primary bot (credentialFirst enforces the isolation rule).
      accountSid: credentialFirst("TWILIO_ACCOUNT_SID", getCredential("twilio", "account_sid")),
      authToken: credentialFirst("TWILIO_AUTH_TOKEN", getCredential("twilio", "auth_token")),
      // Non-secret per-tenant DB columns; env-first like realtimeVoice/escalationExtension.
      number: envFirst("TWILIO_NUMBER", botConfig?.twilio_number),
      voiceProvider:
        (envFirst("VOICE_PROVIDER", botConfig?.voice_provider) ?? "ringcentral").toLowerCase(),
      escalationNumber: envFirst("TWILIO_ESCALATION_NUMBER", botConfig?.escalation_number),
    },
    business: {
      agentName: credentialFirst("AGENT_NAME", botConfig?.agent_name) ?? "Alex",
      brokerageName: credentialFirst("BROKERAGE_NAME", botConfig?.brokerage_name) ?? "our brokerage",
    },
    realtimeVoice:
      envFirst("OPENAI_REALTIME_VOICE", botConfig?.realtime_voice) ?? "alloy",
    escalationExtension: envFirst("ESCALATION_QUEUE_EXTENSION", botConfig?.escalation_extension),
  };
}
