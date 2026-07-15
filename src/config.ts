/**
 * Central config loader. Reads all secrets/settings from environment variables.
 * Fails fast on missing required values so we never boot a half-configured bot
 * that would drop real customer calls.
 */

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

export const config = {
  port: parseInt(optional("PORT", "3000"), 10),
  publicBaseUrl: optional("PUBLIC_BASE_URL", ""),

  ringcentral: {
    clientId: required("RINGCENTRAL_CLIENT_ID"),
    clientSecret: required("RINGCENTRAL_CLIENT_SECRET"),
    serverUrl: optional("RINGCENTRAL_SERVER_URL", "https://platform.ringcentral.com"),
    jwt: required("RINGCENTRAL_JWT"),
    escalationExtension: required("ESCALATION_QUEUE_EXTENSION"),
    webhookVerificationToken: optional("RINGCENTRAL_WEBHOOK_VERIFICATION_TOKEN", ""),
  },

  anthropic: {
    apiKey: required("ANTHROPIC_API_KEY"),
    model: optional("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
  },

  openai: {
    apiKey: required("OPENAI_API_KEY"),
    sttModel: optional("OPENAI_STT_MODEL", "gpt-4o-transcribe"),
    ttsModel: optional("OPENAI_TTS_MODEL", "gpt-4o-mini-tts"),
    ttsVoice: optional("OPENAI_TTS_VOICE", "alloy"),
    embeddingModel: optional("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"),
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
