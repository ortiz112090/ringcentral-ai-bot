import OpenAI from "openai";
import { resolveEffectiveConfig } from "../config";
import { BOT_ID } from "../db/remoteConfig";

/**
 * Shared OpenAI client, reused across the realtime engine, chat (SMS + learning
 * extraction), speech (STT/TTS), and embeddings so we never spin up duplicate
 * clients. This is now the single AI provider for the whole project — the former
 * Anthropic/Claude client has been retired.
 *
 * MULTI-TENANT: like the RingCentral client, the API key is resolved LAZILY from
 * resolveEffectiveConfig() (env + this tenant's Supabase api_credentials), not
 * eagerly at module load from the raw env baseline — which is empty for
 * correctly-configured non-primary tenants and produced 401s on every OpenAI
 * call. Effective config is only available after loadRemoteConfig() warms the
 * cache at startup, so the client is built on first use.
 */

let current: { client: OpenAI; apiKey: string } | null = null;

/** Return the shared OpenAI client, (re)building it if the resolved key changed. */
export async function getOpenAI(): Promise<OpenAI> {
  const { openai } = await resolveEffectiveConfig();
  const apiKey = openai.apiKey;
  if (!apiKey) {
    throw new Error(
      `OpenAI API key missing for tenant BOT_ID=${BOT_ID}. Set it in Supabase ` +
        `api_credentials (provider "openai-tts") for this bot; env-var fallback ` +
        `applies only to the primary bot.`
    );
  }
  if (!current || current.apiKey !== apiKey) {
    current = { client: new OpenAI({ apiKey }), apiKey };
  }
  return current.client;
}
