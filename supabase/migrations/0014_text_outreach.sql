-- ============================================================
-- 0014_text_outreach.sql
-- Text-outreach campaigns (PR E). Adds the 'text_outreach'
-- campaign_type and a per-tenant template table the outreach worker
-- draws its randomized first message from. Replies flow back through
-- the EXISTING inbound SMS pipeline (text_conversations/text_messages);
-- nothing here touches those tables' schema.
--
-- Multi-tenant: text_outreach_templates carries bot_id and is scoped
-- by it in the app (textOutreachWorker / smsQueries). RLS + grants
-- mirror text_stages exactly (authenticated select; admin-only writes
-- via public.is_admin(); service_role full DML; force RLS).
--
-- Idempotent: guarded constraint swap / IF NOT EXISTS so re-running is
-- safe. Executes NOTHING automatically — apply via the Supabase SQL
-- editor or `supabase db push`.
-- ============================================================

-- ============================================================
-- campaigns.campaign_type — allow the new 'text_outreach' type.
-- Drop the existing check (auto-named campaigns_campaign_type_check in
-- 0010) and re-add it widened. Guarded so re-runs are safe.
-- ============================================================
alter table public.campaigns
  drop constraint if exists campaigns_campaign_type_check;
alter table public.campaigns
  add constraint campaigns_campaign_type_check
  check (campaign_type in ('outbound_calls', 'voicemail_drops', 'text_outreach'));

-- ============================================================
-- text_outreach_templates — per-bot pool of first-message templates.
-- The worker loads ACTIVE rows for its bot_id and picks one uniformly
-- at random per contact, substituting {first_name}. Shape/policies
-- deliberately mirror text_stages.
-- ============================================================
create table if not exists public.text_outreach_templates (
  id            uuid primary key default gen_random_uuid(),
  bot_id        uuid not null,
  template_text text not null,
  active        boolean not null default true,
  updated_at    timestamptz not null default now()
);

create index if not exists text_outreach_templates_bot_active_idx
  on public.text_outreach_templates (bot_id, active);

drop trigger if exists trg_text_outreach_templates_updated_at on public.text_outreach_templates;
create trigger trg_text_outreach_templates_updated_at
  before update on public.text_outreach_templates
  for each row execute function public.set_updated_at();

-- ============================================================
-- Grants — authenticated reads only; service_role does the bot's DML.
-- Revoke the auto-granted authenticated writes so table privilege
-- matches the admin-only RLS policy (same as text_stages).
-- ============================================================
grant select                         on public.text_outreach_templates to authenticated;
grant select, insert, update, delete on public.text_outreach_templates to service_role;
revoke insert, update, delete, truncate, references, trigger on public.text_outreach_templates from authenticated;

-- ============================================================
-- RLS — admin-only writes (dashboard), authenticated reads. The bot
-- itself uses the service_role key, which bypasses RLS.
-- ============================================================
alter table public.text_outreach_templates enable row level security;
alter table public.text_outreach_templates force  row level security;

create policy "text_outreach_templates_select_authenticated"
  on public.text_outreach_templates for select to authenticated using (true);
create policy "text_outreach_templates_insert_admin"
  on public.text_outreach_templates for insert to authenticated with check ((select public.is_admin()));
create policy "text_outreach_templates_update_admin"
  on public.text_outreach_templates for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "text_outreach_templates_delete_admin"
  on public.text_outreach_templates for delete to authenticated using ((select public.is_admin()));
