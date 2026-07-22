-- ============================================================
-- 0016_rc_sender_choice.sql
-- Choose the RingCentral sender (PR G). For RC texting the operator
-- now picks WHICH RingCentral user (extension) the bot sends as, and
-- WHICH of that account's SMS-capable numbers texts go out from —
-- instead of being locked to the authenticated extension.
--
-- Adds:
--   * bot_config.rc_sms_extension_id — the chosen RC extension id to
--     send as (null = the authenticated extension, current behavior).
--     rc_sms_number (migration 0012) stays the chosen from-number.
--   * rc_sms_options — a synced read-model the dashboard reads to
--     populate the extension / from-number dropdowns. The backend
--     refreshes it hourly + at startup from the RC account.
--
-- Multi-tenant: rc_sms_options carries bot_id and is scoped by it in
-- the app (rcProvisioning). RLS/grants mirror text_stages (migration
-- 0009): authenticated select, admin-only writes, service_role full,
-- force RLS. The bot uses the service_role key, which bypasses RLS.
--
-- Idempotent: ADD COLUMN / CREATE TABLE / policy creation are all
-- IF NOT EXISTS or guarded so re-running is safe. Executes NOTHING
-- automatically — apply via the Supabase SQL editor or `supabase db push`.
-- ============================================================

-- ============================================================
-- bot_config.rc_sms_extension_id — the chosen RC extension id the bot
-- sends texts as. Null = the authenticated extension ('~'), the
-- pre-PR-G behavior. Non-secret per-tenant column, read fresh per
-- message like the other bot_config settings.
-- ============================================================
alter table public.bot_config
  add column if not exists rc_sms_extension_id text;

-- ============================================================
-- rc_sms_options — synced read-model for the dashboard dropdowns. One
-- row per (bot, extension, SMS-capable phone number). Fully replaced
-- for a bot on each successful sync (see rcProvisioning), so it always
-- reflects the RC account's current extensions + SMS numbers.
-- ============================================================
create table if not exists public.rc_sms_options (
  id               uuid primary key default gen_random_uuid(),
  bot_id           uuid not null,
  extension_id     text not null,
  extension_name   text not null default '',
  extension_number text not null default '',   -- the ext, e.g. '499'
  phone_number     text not null,              -- E.164
  sms_enabled      boolean not null default true,
  synced_at        timestamptz not null default now(),
  unique (bot_id, extension_id, phone_number)
);

create index if not exists rc_sms_options_bot_idx
  on public.rc_sms_options (bot_id);

-- ============================================================
-- Grants — authenticated reads only; service_role does the bot's DML.
-- Revoke the auto-granted authenticated writes so table privilege
-- matches the admin-only RLS policy (same as text_stages).
-- ============================================================
grant select                         on public.rc_sms_options to authenticated;
grant select, insert, update, delete on public.rc_sms_options to service_role;
revoke insert, update, delete, truncate, references, trigger on public.rc_sms_options from authenticated;

-- ============================================================
-- RLS — admin-only writes (dashboard), authenticated reads. The bot
-- itself uses the service_role key, which bypasses RLS.
-- ============================================================
alter table public.rc_sms_options enable row level security;
alter table public.rc_sms_options force  row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'rc_sms_options'
      and policyname = 'rc_sms_options_select_authenticated'
  ) then
    create policy "rc_sms_options_select_authenticated"
      on public.rc_sms_options for select to authenticated using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'rc_sms_options'
      and policyname = 'rc_sms_options_insert_admin'
  ) then
    create policy "rc_sms_options_insert_admin"
      on public.rc_sms_options for insert to authenticated
      with check ((select public.is_admin()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'rc_sms_options'
      and policyname = 'rc_sms_options_update_admin'
  ) then
    create policy "rc_sms_options_update_admin"
      on public.rc_sms_options for update to authenticated
      using ((select public.is_admin())) with check ((select public.is_admin()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'rc_sms_options'
      and policyname = 'rc_sms_options_delete_admin'
  ) then
    create policy "rc_sms_options_delete_admin"
      on public.rc_sms_options for delete to authenticated
      using ((select public.is_admin()));
  end if;
end$$;
