-- ============================================================
-- 0011_outbound_calling.sql
-- Outbound calling engine (PR B). Adds the two columns the Twilio
-- dialer needs on the existing calls table so an outbound campaign
-- call can be recognized and linked back to its campaign_contact:
--
--   * calls.direction          — 'inbound' (default, preserves every
--     existing row's meaning) | 'outbound'. Marks a call placed by the
--     campaign dialer vs. one the bot answered.
--   * calls.campaign_contact_id — nullable FK to campaign_contacts(id).
--     Set on outbound calls so the call row links to the dialed contact;
--     null for inbound calls. ON DELETE SET NULL so removing a contact
--     never deletes call history.
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS). Executes NOTHING
-- automatically — apply via the Supabase SQL editor or `supabase db push`.
-- ============================================================

alter table public.calls
  add column if not exists direction text not null default 'inbound';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'calls_direction_check'
  ) then
    alter table public.calls
      add constraint calls_direction_check
      check (direction in ('inbound', 'outbound'));
  end if;
end$$;

alter table public.calls
  add column if not exists campaign_contact_id bigint
    references public.campaign_contacts (id) on delete set null;

create index if not exists calls_campaign_contact_idx
  on public.calls (campaign_contact_id);

comment on column public.calls.direction is
  'inbound (bot answered) or outbound (campaign dialer placed it). Default inbound.';
comment on column public.calls.campaign_contact_id is
  'For outbound campaign calls, the campaign_contacts row that was dialed; null for inbound.';
