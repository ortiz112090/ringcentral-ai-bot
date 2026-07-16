-- ============================================================
-- 20260716120200_vault_migration.sql
-- Move api_credentials secrets into Supabase Vault.
--
-- Pattern: the table keeps only a REFERENCE (vault_secret_id) to
-- the encrypted blob in vault.secrets. The plaintext `credentials`
-- column is dropped at the end. Only service_role can read/write
-- the decrypted values, via two SECURITY DEFINER functions.
--
-- Assumes: api_credentials is brand new with no existing rows.
-- ============================================================

-- Vault is enabled by default on Supabase; ensure it exists for
-- local dev / self-hosted environments.
create extension if not exists supabase_vault with schema vault;

-- ---- Reference column --------------------------------------
alter table public.api_credentials
  add column vault_secret_id uuid;

-- ============================================================
-- upsert_api_credential(provider, creds)
-- Writes the blob to Vault (create or update) and stores only the
-- returned UUID on the api_credentials row. Returns nothing
-- sensitive. Service-role only.
-- ============================================================
create or replace function public.upsert_api_credential(
  p_provider text,
  p_creds    jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_name      text := 'api_credential:' || p_provider;
begin
  -- Validate provider against the same allow-list as the table.
  if p_provider not in ('render','ringcentral','twilio','openai-tts','elevenlabs') then
    raise exception 'invalid provider: %', p_provider;
  end if;

  -- Does a row (and therefore a Vault secret) already exist?
  select vault_secret_id
    into v_secret_id
  from public.api_credentials
  where provider = p_provider;

  if v_secret_id is null then
    -- Create a new Vault secret; store the blob as text.
    v_secret_id := vault.create_secret(
      p_creds::text,
      v_name,
      'API credentials for ' || p_provider
    );

    insert into public.api_credentials (provider, vault_secret_id)
    values (p_provider, v_secret_id);
  else
    -- Update the existing Vault secret in place.
    perform vault.update_secret(
      v_secret_id,
      p_creds::text,
      v_name,
      'API credentials for ' || p_provider
    );

    -- Touch the row so updated_at fires.
    update public.api_credentials
       set vault_secret_id = v_secret_id
     where provider = p_provider;
  end if;
end;
$$;

-- ============================================================
-- get_api_credential(provider) -> jsonb
-- Reads the decrypted blob from Vault. Service-role only.
-- Returns NULL if the provider has no stored credential.
-- ============================================================
create or replace function public.get_api_credential(
  p_provider text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_plaintext text;
begin
  select vault_secret_id
    into v_secret_id
  from public.api_credentials
  where provider = p_provider;

  if v_secret_id is null then
    return null;
  end if;

  select decrypted_secret
    into v_plaintext
  from vault.decrypted_secrets
  where id = v_secret_id;

  if v_plaintext is null then
    return null;
  end if;

  return v_plaintext::jsonb;
end;
$$;

-- ---- Lock down the functions -------------------------------
-- Revoke the default PUBLIC execute grant, then allow service_role only.
revoke all on function public.upsert_api_credential(text, jsonb) from public, anon, authenticated;
revoke all on function public.get_api_credential(text)          from public, anon, authenticated;

grant execute on function public.upsert_api_credential(text, jsonb) to service_role;
grant execute on function public.get_api_credential(text)          to service_role;

-- ---- Lock down the decrypted view --------------------------
-- End users must NEVER read decrypted secrets directly.
revoke all on vault.decrypted_secrets from anon, authenticated;

-- ---- Drop the plaintext column -----------------------------
-- Safe: table is brand new, no rows to migrate.
alter table public.api_credentials
  drop column credentials;
