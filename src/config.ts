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
import { normalizeRole, type BotRole } from "./roles";
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

  // Shared secret guarding the authenticated web-lead text-outreach endpoint
  // (POST /v1/leads/:botId/text-outreach). When unset the endpoint fails closed
  // (503) rather than accept unauthenticated outreach requests.
  textOutreachSecret: optional("TEXT_OUTREACH_SECRET", ""),

  // Shared token guarding the Drop Cowboy RVM status webhook
  // (POST /webhooks/dropcowboy/status?token=...). When unset the webhook fails
  // closed (503) rather than trust an unauthenticated delivery callback.
  dcWebhookToken: optional("DC_WEBHOOK_TOKEN", ""),

  // Verification token guarding the RingCentral SMS webhook
  // (POST /webhooks/ringcentral/sms). Set on the RC webhook subscription's
  // deliveryMode.validationToken; RC echoes it in the Verification-Token header
  // on every delivered event. When unset the webhook fails closed (503) rather
  // than process unauthenticated payloads.
  rcSmsWebhookToken: optional("RC_SMS_WEBHOOK_TOKEN", ""),

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
    /**
     * Input-transcription model for the realtime session (caller speech → text).
     * Env `OPENAI_TRANSCRIBE_MODEL` first, else a safe default. Defaults to
     * "gpt-4o-transcribe", far more accurate than whisper-1 on 8kHz phone audio.
     */
    transcribeModel: string;
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
  /**
   * SMS texting-bot settings, resolved from bot_config (env fallback only for the
   * primary bot on the model default). All per-tenant; the SMS path reads these
   * fresh each message so dashboard edits apply without a redeploy.
   */
  text: {
    /** Master kill switch; only an explicit true enables the SMS bot. */
    enabled: boolean;
    /** Dedicated Twilio SMS number (E.164) this bot texts from / receives on. */
    number: string | undefined;
    /**
     * RingCentral SMS number (E.164) this bot texts from / receives on. Undefined
     * = RingCentral texting is off for this tenant (Twilio texting is unaffected).
     */
    rcSmsNumber: string | undefined;
    /**
     * Chosen RingCentral extension id the bot sends texts AS. Undefined = the
     * authenticated extension ('~'), the pre-PR-G behavior. The RC send path and
     * the inbound message-store subscription both target this extension.
     */
    rcSmsExtensionId: string | undefined;
    /** OpenAI chat model for SMS turns (default 'gpt-4o-mini'). */
    model: string;
    /** Business name for SMS identification; falls back to agentName. */
    businessName: string;
    /** Sub-toggle: missed-call follow-up texts (default true). */
    missedCallEnabled: boolean;
    /** Sub-toggle: web-lead outreach endpoint (default true). */
    webLeadEnabled: boolean;
    /** IANA timezone for quiet-hours (default 'America/Los_Angeles'). */
    timezone: string;
    /** Texting send-window START hour (0–23, local to timezone; default 8). */
    windowStartHour: number;
    /** Texting send-window END hour (0–23, exclusive; default 21). */
    windowEndHour: number;
  };
  /**
   * Role gate for this tenant (bot_config.bot_role), normalized to a valid BotRole.
   * All pipeline gating funnels through roleAllows() (see ../roles). Read fresh per
   * event so a dashboard change applies without a redeploy.
   */
  botRole: BotRole;
  /**
   * Drop Cowboy ringless-voicemail credentials (api_credentials provider
   * 'dropcowboy'). DB-first; env fallback (DROPCOWBOY_TEAM_ID/SECRET/BRAND_ID) only
   * for the primary bot — identical isolation rule to the Twilio credentials.
   */
  dropcowboy: {
    teamId: string | undefined;
    secret: string | undefined;
    brandId: string | undefined;
  };
  /**
   * Velocify report-sync settings + credentials. Settings come from the new
   * bot_config columns (per-tenant, dashboard-editable); credentials come from
   * api_credentials provider "velocify" (DB-first, env fallback for the primary bot
   * only via credentialFirst — same isolation rule as the other integrations). Read
   * fresh per sync so dashboard edits apply on the next tick with no redeploy.
   */
  velocify: {
    enabled: boolean;
    reportId: string | undefined;
    firstNameColumn: string;
    phoneColumn: string;
    excludedFirstNames: string[];
    syncIntervalMinutes: number;
    pacePerHour: number;
    lastSyncedAt: string | undefined;
    username: string | undefined;
    password: string | undefined;
    /** SOAP endpoint override; undefined → the module default. */
    endpoint: string | undefined;
  };
  realtimeVoice: string;
  /**
   * Realtime output speaking rate, resolved env-first
   * (OPENAI_REALTIME_SPEED → bot_config.voice_speed → 1.0) and clamped to OpenAI's
   * supported range [0.25, 1.5]. Sent as session.audio.output.speed.
   */
  realtimeSpeed: number;
  escalationExtension: string | undefined;
  /**
   * Server-VAD turn-detection tuning for the realtime session, sourced from
   * bot_config (with the seeded defaults when the columns are null/missing).
   * Higher `vadThreshold` + longer `vadSilenceMs` make the bot less likely to
   * treat phone-line breath/noise as the caller taking a turn.
   */
  voice: {
    vadThreshold: number;
    vadSilenceMs: number;
    vadPrefixPaddingMs: number;
    /** When false, caller speech does not interrupt/flush the bot's outgoing audio. */
    bargeInEnabled: boolean;
  };
}

/** bot_config defaults for the VAD columns (mirror the migration defaults). */
const VAD_DEFAULTS = {
  threshold: 0.7,
  silenceMs: 800,
  prefixPaddingMs: 300,
  bargeInEnabled: true,
} as const;

/** Numeric bot_config value, or the default when null/undefined/non-finite. */
function numberOr(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Velocify sync bot_config defaults (mirror the migration column defaults). */
const VELOCIFY_DEFAULTS = {
  firstNameColumn: "D",
  phoneColumn: "F",
  excludedFirstNames: ["inbound call"],
  syncIntervalMinutes: 360,
  pacePerHour: 100,
} as const;

/**
 * Coerce the velocify_excluded_first_names jsonb value into a string[]. Supabase
 * returns jsonb already parsed; accept an array of strings (a JSON string is parsed
 * defensively). Anything unusable falls back to the default single-entry list.
 */
export function parseExcludedFirstNames(value: unknown): string[] {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [...VELOCIFY_DEFAULTS.excludedFirstNames];
    }
  }
  if (Array.isArray(raw)) {
    const names = raw.filter((v): v is string => typeof v === "string");
    return names.length > 0 ? names : [...VELOCIFY_DEFAULTS.excludedFirstNames];
  }
  return [...VELOCIFY_DEFAULTS.excludedFirstNames];
}

/** OpenAI Realtime output-speed bounds and default. */
const REALTIME_SPEED_MIN = 0.25;
const REALTIME_SPEED_MAX = 1.5;
const REALTIME_SPEED_DEFAULT = 1.0;

/**
 * Resolve a raw voice-speed value (env string or bot_config numeric) into a valid
 * OpenAI Realtime output speed. Non-numeric/null/undefined → 1.0; numeric values are
 * clamped to the supported range [0.25, 1.5]. Pure and side-effect free for tests.
 */
export function resolveRealtimeSpeed(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
      ? parseFloat(value)
      : NaN;
  if (!Number.isFinite(n)) return REALTIME_SPEED_DEFAULT;
  return Math.min(REALTIME_SPEED_MAX, Math.max(REALTIME_SPEED_MIN, n));
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
 * Public URL Twilio requests for TwiML when an OUTBOUND campaign call connects
 * (the `url` on calls.create). The dialed contact's id rides as a ?contactId query
 * param so the webhook can link the call back to its campaign_contact. The full URL
 * (with query string) is also what Twilio signs, so signature validation must use
 * this exact string. Returns "" when PUBLIC_BASE_URL is unset so the worker can
 * detect the misconfiguration and skip dialing.
 */
export function twilioVoiceOutboundWebhookUrl(contactId: number | string): string {
  const base = publicBase();
  if (!base) return "";
  return `${base}/webhooks/twilio/voice-outbound?contactId=${encodeURIComponent(String(contactId))}`;
}

/**
 * Public URL Twilio POSTs inbound SMS params to (the SMS webhook), used for
 * X-Twilio-Signature validation and for pointing the texting number's messaging
 * webhook at us. Returns "" when PUBLIC_BASE_URL is unset.
 */
export function twilioSmsWebhookUrl(): string {
  const base = publicBase();
  return base ? `${base}/webhooks/twilio/sms` : "";
}

/**
 * Public URL RingCentral delivers inbound-SMS message-store events to (the RC SMS
 * webhook). Used both as the subscription's deliveryMode.address when provisioning
 * and to match an existing subscription as ours. Returns "" when PUBLIC_BASE_URL
 * is unset so provisioning can skip rather than register a broken address.
 *
 * The shared secret rides in the address as a `?token=` query param: RC does NOT
 * send a Verification-Token header on delivered notifications, but it echoes the
 * full subscription address (query included) on every delivery, so the token in
 * the URL is what the handler authenticates against. When the token is unset the
 * bare URL is returned (and the handler fails closed with 503).
 */
export function ringcentralSmsWebhookUrl(): string {
  const base = publicBase();
  if (!base) return "";
  const url = `${base}/webhooks/ringcentral/sms`;
  const token = config.rcSmsWebhookToken.trim();
  return token ? `${url}?token=${encodeURIComponent(token)}` : url;
}

/**
 * Base URL the "Sign in with RingCentral" OAuth flow builds its redirect_uri from.
 * Reuses PUBLIC_BASE_URL (the same base the RC webhook address uses); when unset,
 * falls back to the deployed service URL so sign-in still works out of the box.
 */
const RC_OAUTH_BASE_FALLBACK = "https://ringcentral-ai-bot.onrender.com";
export function rcOAuthBaseUrl(): string {
  return publicBase() || RC_OAUTH_BASE_FALLBACK;
}

/**
 * The OAuth redirect_uri RingCentral sends the authorization code back to. MUST be
 * byte-identical on the /authorize request and the token exchange, so both derive
 * it from this one function.
 */
export function rcOAuthCallbackUrl(): string {
  return `${rcOAuthBaseUrl()}/rc/oauth/callback`;
}

/**
 * Callback URL Drop Cowboy POSTs RVM delivery status to, with the shared token as a
 * query param so the webhook can fail closed on a missing/wrong token. Returns ""
 * when PUBLIC_BASE_URL is unset so the worker can detect the misconfiguration.
 */
export function dropCowboyStatusCallbackUrl(): string {
  const base = publicBase();
  if (!base) return "";
  const token = config.dcWebhookToken.trim();
  const url = `${base}/webhooks/dropcowboy/status`;
  return token ? `${url}?token=${encodeURIComponent(token)}` : url;
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
  // Lazy import to avoid a module-load import cycle (see import note above). Under
  // CommonJS this downlevels to a deferred require, so the cycle-avoidance is
  // unchanged; using import() keeps it resolvable/mockable in the test runner.
  const { getRemoteConfig, getCredential, BOT_ID } = await import("./db/remoteConfig");

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
      // The Lovable dashboard writes this tenant's OpenAI key under provider
      // "openai" (key "api_key"); provider "openai-tts" is the legacy fallback
      // for bots configured before the dashboard change. Env still wins first,
      // and only for the primary bot (credentialFirst enforces the isolation).
      apiKey: credentialFirst(
        "OPENAI_API_KEY",
        getCredential("openai", "api_key") ?? getCredential("openai-tts", "api_key")
      ),
      // Env-first, then a bot_config column if one is ever added (none today — no
      // migration), then the hardcoded default. Not a credential, so plain envFirst.
      transcribeModel:
        envFirst(
          "OPENAI_TRANSCRIBE_MODEL",
          (botConfig as { transcribe_model?: string | null } | null)?.transcribe_model
        ) ?? "gpt-4o-transcribe",
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
    text: {
      // Only an explicit true enables the SMS bot (mirrors the voice kill switch).
      enabled: botConfig?.text_enabled === true,
      // Non-secret per-tenant column; env-first like the voice number.
      number: envFirst("TWILIO_SMS_NUMBER", botConfig?.text_number),
      // RingCentral texting number; non-secret per-tenant column, env-first.
      rcSmsNumber: envFirst("RC_SMS_NUMBER", botConfig?.rc_sms_number),
      // Chosen RC extension to send as; non-secret per-tenant column, env-first.
      // Undefined keeps the authenticated-extension ('~') behavior.
      rcSmsExtensionId: envFirst("RC_SMS_EXTENSION_ID", botConfig?.rc_sms_extension_id),
      model:
        envFirst("OPENAI_TEXT_MODEL", botConfig?.text_model) ?? "gpt-4o-mini",
      businessName:
        (botConfig?.business_name && botConfig.business_name.trim() !== ""
          ? botConfig.business_name.trim()
          : undefined) ??
        credentialFirst("AGENT_NAME", botConfig?.agent_name) ??
        "Alex",
      // Sub-toggles default ON: only an explicit false disables them.
      missedCallEnabled: botConfig?.missed_call_text_enabled !== false,
      webLeadEnabled: botConfig?.web_lead_text_enabled !== false,
      // Send-window timezone: env-first, then the dedicated text_timezone column,
      // then the legacy shared `timezone` column, then the default.
      timezone:
        envFirst("BOT_TIMEZONE", botConfig?.text_timezone ?? botConfig?.timezone) ??
        "America/Los_Angeles",
      // Per-bot send-window bounds; default 8/21 when the columns are null/absent.
      windowStartHour: numberOr(botConfig?.text_window_start_hour, 8),
      windowEndHour: numberOr(botConfig?.text_window_end_hour, 21),
    },
    botRole: normalizeRole(envFirst("BOT_ROLE", botConfig?.bot_role)),
    dropcowboy: {
      teamId: credentialFirst("DROPCOWBOY_TEAM_ID", getCredential("dropcowboy", "team_id")),
      secret: credentialFirst("DROPCOWBOY_SECRET", getCredential("dropcowboy", "secret")),
      brandId: credentialFirst("DROPCOWBOY_BRAND_ID", getCredential("dropcowboy", "brand_id")),
    },
    velocify: {
      // Only an explicit true enables the sync (mirrors the other kill switches).
      enabled: botConfig?.velocify_sync_enabled === true,
      reportId:
        botConfig?.velocify_report_id && botConfig.velocify_report_id.trim() !== ""
          ? botConfig.velocify_report_id.trim()
          : undefined,
      firstNameColumn:
        botConfig?.velocify_first_name_column && botConfig.velocify_first_name_column.trim() !== ""
          ? botConfig.velocify_first_name_column.trim()
          : VELOCIFY_DEFAULTS.firstNameColumn,
      phoneColumn:
        botConfig?.velocify_phone_column && botConfig.velocify_phone_column.trim() !== ""
          ? botConfig.velocify_phone_column.trim()
          : VELOCIFY_DEFAULTS.phoneColumn,
      excludedFirstNames: parseExcludedFirstNames(botConfig?.velocify_excluded_first_names),
      syncIntervalMinutes: numberOr(
        botConfig?.velocify_sync_interval_minutes,
        VELOCIFY_DEFAULTS.syncIntervalMinutes
      ),
      pacePerHour: numberOr(botConfig?.velocify_pace_per_hour, VELOCIFY_DEFAULTS.pacePerHour),
      lastSyncedAt:
        botConfig?.velocify_last_synced_at && botConfig.velocify_last_synced_at.trim() !== ""
          ? botConfig.velocify_last_synced_at
          : undefined,
      // Credentials: DB (api_credentials provider "velocify") first, env fallback only
      // for the primary bot (credentialFirst enforces the multi-tenant isolation).
      username: credentialFirst("VELOCIFY_USERNAME", getCredential("velocify", "username")),
      password: credentialFirst("VELOCIFY_PASSWORD", getCredential("velocify", "password")),
      // Endpoint is a non-secret override; DB-only (no env var), undefined → default.
      endpoint: getCredential("velocify", "endpoint"),
    },
    realtimeVoice:
      envFirst("OPENAI_REALTIME_VOICE", botConfig?.realtime_voice) ?? "alloy",
    // Env-first: OPENAI_REALTIME_SPEED (string) wins, else bot_config.voice_speed
    // (numeric, absent/null-tolerant), else 1.0. Clamped to [0.25, 1.5].
    realtimeSpeed: resolveRealtimeSpeed(
      envValue("OPENAI_REALTIME_SPEED") ?? botConfig?.voice_speed
    ),
    escalationExtension: envFirst("ESCALATION_QUEUE_EXTENSION", botConfig?.escalation_extension),
    voice: {
      vadThreshold: numberOr(botConfig?.vad_threshold, VAD_DEFAULTS.threshold),
      vadSilenceMs: numberOr(botConfig?.vad_silence_ms, VAD_DEFAULTS.silenceMs),
      vadPrefixPaddingMs: numberOr(botConfig?.vad_prefix_padding_ms, VAD_DEFAULTS.prefixPaddingMs),
      // Only an explicit false disables barge-in; null/missing keeps the default (true).
      bargeInEnabled: botConfig?.barge_in_enabled !== false,
    },
  };
}
