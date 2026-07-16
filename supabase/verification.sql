-- ============================================================
-- verification.sql
-- Run in the SQL editor (or psql) after applying all migrations.
-- ============================================================

-- 1) Tables exist + RLS enabled/forced
select
  c.relname             as table_name,
  c.relrowsecurity      as rls_enabled,
  c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('api_credentials','bot_config')
order by c.relname;
-- Expect: both rows show rls_enabled = true and rls_forced = true.

-- 2) Policies attached (expect 4 per table: 1 select + 3 write = 8 total)
select
  schemaname,
  tablename,
  policyname,
  cmd,
  roles,
  qual       as using_expr,
  with_check as check_expr
from pg_policies
where schemaname = 'public'
  and tablename in ('api_credentials','bot_config')
order by tablename, cmd, policyname;

-- 3) Grants
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('api_credentials','bot_config')
  and grantee in ('authenticated','service_role')
order by table_name, grantee, privilege_type;
-- Expect: authenticated -> SELECT only; service_role -> SELECT/INSERT/UPDATE/DELETE.

-- 4) EXTRA: confirm authenticated + anon have NO privileges on
--    vault.decrypted_secrets (should return ZERO rows).
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'vault'
  and table_name = 'decrypted_secrets'
  and grantee in ('authenticated','anon');
-- Expect: 0 rows. If any row is returned, the REVOKE did not take.

-- 5) EXTRA: confirm the vault helper functions are service_role-only
--    (authenticated/anon should NOT be able to execute them).
select
  p.proname            as function_name,
  r.rolname            as grantee,
  has_function_privilege(r.rolname, p.oid, 'EXECUTE') as can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (values ('anon'),('authenticated'),('service_role')) as r(rolname)
where n.nspname = 'public'
  and p.proname in ('upsert_api_credential','get_api_credential')
order by function_name, grantee;
-- Expect: can_execute = true ONLY for service_role; false for anon/authenticated.

-- 6) EXTRA: confirm the five providers were seeded, each with a
--    Vault reference (run as service_role / in the SQL editor).
select provider, (vault_secret_id is not null) as has_vault_ref, updated_at
from public.api_credentials
order by provider;
-- Expect: 5 rows (elevenlabs, openai-tts, render, ringcentral, twilio),
-- each with has_vault_ref = true.
