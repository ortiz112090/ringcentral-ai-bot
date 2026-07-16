// supabase/functions/_shared/credentials.ts
//
// Credential resolution helper for edge functions.
//
// Priority:
//   1. Deno.env (Supabase Function Secrets) — source of truth.
//   2. Fallback: get_api_credential(provider) via the service-role
//      client, which reads the encrypted blob from Supabase Vault.
//
// SECURITY:
//   - Never log or return the decrypted blob.
//   - Uses the SERVICE ROLE key; only ever runs server-side in an
//     edge function. Do NOT import this into client code.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

let _admin: SupabaseClient | null = null;

/** Lazily-created service-role client (bypasses RLS). */
function adminClient(): SupabaseClient {
  if (_admin) return _admin;

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  _admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _admin;
}

/**
 * Resolve a credential blob for a provider.
 *
 * @param provider  One of: render | ringcentral | twilio | openai-tts | elevenlabs
 * @param envKeys   Env var names to try first (Function Secrets). If ALL of
 *                  these are present, they win and Vault is never queried.
 *                  Each resolved env value is placed under its own key in the
 *                  returned object (keyed by the env var name).
 *
 * @returns A Record<string, unknown> of credential values, or null if nothing
 *          could be resolved from either env or Vault.
 *
 * NOTE: the returned object is sensitive — never log it or send it to a client.
 */
export async function getCredential(
  provider: string,
  envKeys: string[] = [],
): Promise<Record<string, unknown> | null> {
  // 1) Source of truth: Function Secrets / env.
  if (envKeys.length > 0) {
    const fromEnv: Record<string, unknown> = {};
    let allPresent = true;

    for (const key of envKeys) {
      const val = Deno.env.get(key);
      if (val === undefined || val === "") {
        allPresent = false;
        break;
      }
      fromEnv[key] = val;
    }

    if (allPresent) return fromEnv;
  }

  // 2) Fallback: Vault, via the service-role-only RPC.
  const { data, error } = await adminClient().rpc("get_api_credential", {
    p_provider: provider,
  });

  if (error) {
    // Log the error MESSAGE only — never the credential contents.
    console.error(`getCredential(${provider}) vault lookup failed:`, error.message);
    return null;
  }

  if (data == null) return null;

  return data as Record<string, unknown>;
}
