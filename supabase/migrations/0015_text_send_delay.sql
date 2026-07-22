-- ============================================================
-- 0015_text_send_delay.sql
-- Per-campaign send delay (minutes) for text_outreach blasts (PR F).
--
-- Adds campaigns.send_delay_minutes: an OPTIONAL "one text every N
-- minutes" spacing that overrides pace_per_hour for text_outreach
-- campaigns. When set (1–1440), the text-outreach worker claims/sends
-- AT MOST ONE contact per tick for that campaign, and only once the
-- newest attempt (sent/skipped/failed) is older than N minutes. When
-- NULL, the existing pace_per_hour behavior is completely unchanged.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + guarded check constraint so
-- re-running is safe. Executes NOTHING automatically — apply via the
-- Supabase SQL editor or `supabase db push`.
-- ============================================================

-- ============================================================
-- campaigns.send_delay_minutes — nullable spacing override. NULL
-- preserves the current pace_per_hour behavior for every existing
-- campaign.
-- ============================================================
alter table public.campaigns
  add column if not exists send_delay_minutes integer;

-- ============================================================
-- Guarded range check: NULL (pace path) or 1–1440 minutes (up to 24h).
-- ============================================================
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'campaigns_send_delay_minutes_check'
  ) then
    alter table public.campaigns
      add constraint campaigns_send_delay_minutes_check
      check (send_delay_minutes is null or (send_delay_minutes between 1 and 1440));
  end if;
end$$;
