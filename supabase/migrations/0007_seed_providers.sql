-- ============================================================
-- 20260716120300_seed_providers.sql
-- Pre-create one row per provider with an empty credentials blob.
--
-- Uses upsert_api_credential() so each row gets a real Vault secret
-- (an empty JSON object) and a vault_secret_id reference. Populate
-- the real values later via:
--   select public.upsert_api_credential('ringcentral', '{...}'::jsonb);
--
-- Idempotent: upsert_api_credential updates in place if the provider
-- already exists, so re-running is safe.
-- ============================================================

select public.upsert_api_credential('render',      '{}'::jsonb);
select public.upsert_api_credential('ringcentral', '{}'::jsonb);
select public.upsert_api_credential('twilio',      '{}'::jsonb);
select public.upsert_api_credential('openai-tts',  '{}'::jsonb);
select public.upsert_api_credential('elevenlabs',  '{}'::jsonb);
