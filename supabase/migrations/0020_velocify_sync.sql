-- ============================================================
-- 0020_velocify_sync.sql
-- Velocify report sync → text-outreach pipeline (PR T).
--
-- Adds the per-tenant, dashboard-editable bot_config columns that
-- drive the scheduled + manual Velocify report sync. The sync pulls a
-- Velocify report (SOAP GetReportResults), filters/dedupes the rows,
-- and drops new (first_name, phone) people onto the tenant's
-- auto-created 'Velocify Report Sync' text_outreach campaign. The
-- EXISTING text-outreach worker then paces the sends and the inbound
-- AI script handles replies — no schema changes to campaigns /
-- campaign_contacts / text_conversations are needed here.
--
-- Credentials (username/password, optional endpoint) live in
-- api_credentials under provider 'velocify' — NOT in this table.
--
-- Multi-tenant: bot_config already carries bot_id and is scoped by it
-- in the app (remoteConfig / resolveEffectiveConfig).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + guarded range checks so
-- re-running is safe. Executes NOTHING automatically — apply via the
-- Supabase SQL editor or `supabase db push`.
-- ============================================================

-- Master toggle for the scheduled sync. Only an explicit true enables it.
alter table public.bot_config
  add column if not exists velocify_sync_enabled boolean not null default false;

-- Velocify report id to pull (e.g. '87'). NULL/blank gates the sync off.
alter table public.bot_config
  add column if not exists velocify_report_id text;

-- Spreadsheet column letters the parser maps positionally (A=0, D=3, F=5, ...).
alter table public.bot_config
  add column if not exists velocify_first_name_column text not null default 'D';

alter table public.bot_config
  add column if not exists velocify_phone_column text not null default 'F';

-- Case-insensitive first names to exclude (matched trimmed/lower-cased).
alter table public.bot_config
  add column if not exists velocify_excluded_first_names jsonb not null
    default '["inbound call"]'::jsonb;

-- Minimum minutes between scheduled syncs (worker-tick interval gate).
alter table public.bot_config
  add column if not exists velocify_sync_interval_minutes integer not null default 360;

-- pace_per_hour applied to the auto-created 'Velocify Report Sync' campaign.
alter table public.bot_config
  add column if not exists velocify_pace_per_hour integer not null default 100;

-- State: timestamp of the last successful sync (written by the bot, not the dashboard).
alter table public.bot_config
  add column if not exists velocify_last_synced_at timestamptz;

-- ============================================================
-- Guarded range checks: keep the interval + pace positive and bounded
-- so a fat-fingered dashboard value can't wedge the worker.
-- ============================================================
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bot_config_velocify_sync_interval_minutes_check'
  ) then
    alter table public.bot_config
      add constraint bot_config_velocify_sync_interval_minutes_check
      check (velocify_sync_interval_minutes between 1 and 10080);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'bot_config_velocify_pace_per_hour_check'
  ) then
    alter table public.bot_config
      add constraint bot_config_velocify_pace_per_hour_check
      check (velocify_pace_per_hour between 1 and 100000);
  end if;
end$$;

-- ============================================================
-- Credentials reminder (NOT executed here — informational):
--   insert into public.api_credentials (bot_id, provider, credentials)
--   values ('<bot-uuid>', 'velocify',
--           jsonb_build_object('username', '<user>', 'password', '<pass>'))
--   on conflict (bot_id, provider) do update set credentials = excluded.credentials;
-- Optional endpoint override lives under the same row's `endpoint` key.
-- ============================================================
