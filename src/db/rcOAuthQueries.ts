import { logger } from "../logger";
import { BOT_ID } from "./remoteConfig";

/**
 * DB access for the "Sign in with RingCentral" OAuth flow (PR H), multi-tenant
 * and scoped by bot_id. Two pieces of state:
 *
 *   - The OAuth refresh token — a SECRET — lives in api_credentials under the
 *     existing "ringcentral" provider row (same row/shape client_id/secret/jwt
 *     already use), key `rc_refresh_token`. Merged into the existing credentials
 *     jsonb so the JWT-flow secrets are preserved.
 *   - The signed-in display label — non-secret — lives in bot_config
 *     (rc_signed_in_label, see migration 0017).
 *
 * Every write is failure-tolerant (Supabase error logged, no secret values, then
 * swallowed) so a dropped write never crashes the never-throwing OAuth endpoints
 * or the token manager.
 */

/** api_credentials provider row that holds the RC secrets. */
export const RC_PROVIDER = "ringcentral";
/** Key under the ringcentral credentials jsonb holding the OAuth refresh token. */
export const RC_REFRESH_TOKEN_KEY = "rc_refresh_token";

/**
 * Lazily resolve the Supabase client. Imported on demand (not at module load) so
 * that consumers who only need the exported constants — e.g. client.ts importing
 * RC_REFRESH_TOKEN_KEY — don't eagerly pull in the Supabase/config module graph.
 */
async function db() {
  const { supabase } = await import("./supabase");
  return supabase;
}

/**
 * Upsert this bot's OAuth refresh token into api_credentials, MERGING into the
 * existing "ringcentral" credentials jsonb so client_id/client_secret/jwt are
 * preserved. Called after EVERY RC token response (code exchange + each refresh),
 * because RingCentral rotates refresh tokens. Failure-tolerant.
 */
export async function persistRcRefreshToken(
  refreshToken: string,
  botId: string = BOT_ID
): Promise<void> {
  const token = (refreshToken ?? "").trim();
  if (token === "") return;

  const supabase = await db();
  const { data, error } = await supabase
    .from("api_credentials")
    .select("credentials")
    .eq("bot_id", botId)
    .eq("provider", RC_PROVIDER)
    .maybeSingle();
  if (error) {
    logger.error("Failed to read ringcentral credentials before persisting refresh token", {
      botId,
      error: error.message,
    });
    return;
  }

  const current =
    (data?.credentials as Record<string, unknown> | null | undefined) ?? {};
  const merged = { ...current, [RC_REFRESH_TOKEN_KEY]: token };

  const { error: upErr } = await supabase
    .from("api_credentials")
    .upsert({ bot_id: botId, provider: RC_PROVIDER, credentials: merged }, {
      onConflict: "bot_id,provider",
    });
  if (upErr) {
    logger.error("Failed to persist RingCentral OAuth refresh token", {
      botId,
      error: upErr.message,
    });
  }
}

/**
 * Set (or clear, with '') this bot's signed-in display label in bot_config.
 * Non-secret. Failure-tolerant.
 */
export async function setRcSignedInLabel(
  label: string,
  botId: string = BOT_ID
): Promise<void> {
  const supabase = await db();
  const { error } = await supabase
    .from("bot_config")
    .update({ rc_signed_in_label: label })
    .eq("bot_id", botId);
  if (error) {
    logger.error("Failed to update rc_signed_in_label", { botId, error: error.message });
  }
}
