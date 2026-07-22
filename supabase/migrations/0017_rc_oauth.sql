-- ============================================================
-- 0017_rc_oauth.sql
-- "Sign in with RingCentral" (OAuth Authorization Code) — send as the
-- signed-in user (PR H).
--
-- The operator clicks "Sign in with RingCentral" in the dashboard and logs
-- in AS the RingCentral user the bot should text from. The OAuth refresh
-- token is a SECRET and lives ONLY in api_credentials (provider
-- "ringcentral", key rc_refresh_token) — never in bot_config. This migration
-- adds only the display-only, non-secret label the dashboard shows so the
-- operator can see who the bot is currently signed in as.
--
-- Adds:
--   * bot_config.rc_signed_in_label — a human label for the signed-in RC
--     identity, e.g. "Joal Ortiz — ext 499 (+1205...)". '' = signed out.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS is safe to re-run. Executes NOTHING
-- automatically — apply via the Supabase SQL editor or `supabase db push`.
-- ============================================================

-- ============================================================
-- bot_config.rc_signed_in_label — display-only, non-secret. Set on a
-- successful OAuth callback; cleared to '' when the sign-in expires
-- (refresh token revoked → invalid_grant) so the dashboard shows signed-out.
-- Read fresh per use like the other bot_config settings.
-- ============================================================
alter table public.bot_config
  add column if not exists rc_signed_in_label text not null default '';
