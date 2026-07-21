-- ============================================================
-- 0010_campaigns.sql
-- Campaigns add-on: bot roles + campaign tables for the outbound
-- calling and Drop Cowboy ringless-voicemail (RVM) engines.
--
-- Adds:
--   * bot_config.bot_role — per-tenant role gate (answer_calls |
--     outbound_calls | answer_and_followup | texting), read fresh
--     per event so a dashboard change needs no redeploy.
--   * campaigns — one row per outbound campaign (calls or RVM drops).
--   * campaign_contacts — the dial/drop list for a campaign. The
--     dashboard parses CSV/XLS client-side and inserts these rows
--     directly; the backend never parses files.
--
-- Multi-tenant: every table carries bot_id and is scoped by it in
-- the app. RLS + grants mirror text_stages (migration 0009):
-- authenticated select; insert/update/delete require public.is_admin();
-- service_role does the bot's own DML; RLS enabled + forced.
--
-- Idempotent: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS so re-running
-- is safe. Executes NOTHING automatically — apply via the Supabase
-- SQL editor or `supabase db push`.
-- ============================================================

-- ============================================================
-- bot_config.bot_role — role gate. Default 'answer_calls' preserves
-- the current inbound-voice behavior for every existing tenant.
-- ============================================================
alter table public.bot_config
  add column if not exists bot_role text not null default 'answer_calls';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bot_config_bot_role_check'
  ) then
    alter table public.bot_config
      add constraint bot_config_bot_role_check
      check (bot_role in ('answer_calls', 'outbound_calls', 'answer_and_followup', 'texting'));
  end if;
end$$;

-- ============================================================
-- campaigns — one row per outbound campaign for a bot.
-- campaign_type gates which worker owns it:
--   outbound_calls  → Twilio dialer (PR B)
--   voicemail_drops → Drop Cowboy RVM engine (PR A)
-- dc_recording_id is the Drop Cowboy recording GUID, required for
-- voicemail_drops (enforced in the worker, not the schema, so a
-- draft row can be saved before a recording is chosen).
-- ============================================================
create table if not exists public.campaigns (
  id             uuid primary key default gen_random_uuid(),
  bot_id         uuid not null,
  name           text not null,
  campaign_type  text not null check (campaign_type in ('outbound_calls', 'voicemail_drops')),
  status         text not null default 'draft' check (status in ('draft', 'running', 'paused', 'completed')),
  pace_per_hour  int  not null default 100,
  dc_recording_id text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists campaigns_bot_status_idx
  on public.campaigns (bot_id, status);

drop trigger if exists trg_campaigns_updated_at on public.campaigns;
create trigger trg_campaigns_updated_at
  before update on public.campaigns
  for each row execute function public.set_updated_at();

-- ============================================================
-- campaign_contacts — the dial/drop list. Dedupe on
-- (campaign_id, phone_number) so a re-uploaded CSV can't double-dial
-- the same number within a campaign. status tracks the worker's
-- progress through the row; outcome carries the provider result /
-- skip reason (e.g. 'opted_out').
-- ============================================================
create table if not exists public.campaign_contacts (
  id            bigint generated always as identity primary key,
  bot_id        uuid not null,
  campaign_id   uuid not null references public.campaigns (id) on delete cascade,
  phone_number  text not null,
  first_name    text,
  last_name     text,
  data          jsonb not null default '{}'::jsonb,
  status        text not null default 'pending'
                check (status in ('pending', 'processing', 'sent', 'completed', 'failed', 'skipped')),
  outcome       text,
  attempted_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique (campaign_id, phone_number)
);

create index if not exists campaign_contacts_campaign_status_idx
  on public.campaign_contacts (campaign_id, status);
create index if not exists campaign_contacts_bot_idx
  on public.campaign_contacts (bot_id);

-- ============================================================
-- Grants — authenticated reads only; service_role does the bot's DML.
-- Revoke the auto-granted authenticated writes so table privilege
-- matches the admin-only RLS policy (same as text_stages).
-- ============================================================
grant select                         on public.campaigns          to authenticated;
grant select, insert, update, delete on public.campaigns          to service_role;
revoke insert, update, delete, truncate, references, trigger on public.campaigns from authenticated;

grant select                         on public.campaign_contacts  to authenticated;
grant select, insert, update, delete on public.campaign_contacts  to service_role;
revoke insert, update, delete, truncate, references, trigger on public.campaign_contacts from authenticated;

-- ============================================================
-- RLS — admin-only writes (dashboard), authenticated reads. The bot
-- itself uses the service_role key, which bypasses RLS.
-- ============================================================
alter table public.campaigns         enable row level security;
alter table public.campaigns         force  row level security;
alter table public.campaign_contacts enable row level security;
alter table public.campaign_contacts force  row level security;

-- campaigns policies
create policy "campaigns_select_authenticated"
  on public.campaigns for select to authenticated using (true);
create policy "campaigns_insert_admin"
  on public.campaigns for insert to authenticated with check ((select public.is_admin()));
create policy "campaigns_update_admin"
  on public.campaigns for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "campaigns_delete_admin"
  on public.campaigns for delete to authenticated using ((select public.is_admin()));

-- campaign_contacts policies
create policy "campaign_contacts_select_authenticated"
  on public.campaign_contacts for select to authenticated using (true);
create policy "campaign_contacts_insert_admin"
  on public.campaign_contacts for insert to authenticated with check ((select public.is_admin()));
create policy "campaign_contacts_update_admin"
  on public.campaign_contacts for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "campaign_contacts_delete_admin"
  on public.campaign_contacts for delete to authenticated using ((select public.is_admin()));
