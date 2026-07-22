-- ============================================================
-- 0013_script_suggestions.sql
-- Script-suggestion learning loop. One new table (script_suggestions)
-- that the analyzer (src/learning/analyzer.ts) fills with PENDING
-- improvement suggestions distilled from real conversations. The bot
-- NEVER edits the live script itself — an operator approves/rejects
-- each suggestion in the dashboard, and the dashboard (not this bot)
-- copies an approved reword into the target stage.
--
-- Multi-tenant: the table carries bot_id and is scoped by it in the
-- app (analyzer / suggestionQueries). RLS + grants mirror text_stages
-- (0009): authenticated reads, admin-only writes via public.is_admin(),
-- service_role does the bot's own inserts.
--
-- Idempotent: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS so re-running is
-- safe. Executes NOTHING automatically — apply via the Supabase SQL
-- editor or `supabase db push`.
-- ============================================================

-- ============================================================
-- script_suggestions — pending/approved/rejected suggestions for a
-- bot's text (or, later, voice) script. stage_id targets the
-- text_stages/script_stages row the suggestion is about; null means a
-- brand-new-stage or new-FAQ suggestion.
-- ============================================================
create table if not exists public.script_suggestions (
  id               uuid primary key default gen_random_uuid(),
  bot_id           uuid not null,
  flow             text not null check (flow in ('text', 'voice')),
  -- The text_stages/script_stages row this targets; null = new-stage/new-FAQ.
  stage_id         bigint,
  suggestion_type  text not null check (suggestion_type in ('reword', 'new_stage', 'new_faq')),
  current_text     text,
  suggested_text   text not null,
  rationale        text not null,
  -- Array of {conversation_id, snippet} objects citing the evidence.
  evidence         jsonb not null default '[]'::jsonb,
  status           text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at       timestamptz not null default now(),
  decided_at       timestamptz
);

create index if not exists script_suggestions_bot_status_idx
  on public.script_suggestions (bot_id, status, created_at desc);
create index if not exists script_suggestions_bot_flow_idx
  on public.script_suggestions (bot_id, flow, created_at desc);

-- Prevent duplicate PENDING suggestions for the same target/wording so a
-- daily re-run can't pile up identical rows. Once a suggestion is decided
-- (approved/rejected) it no longer blocks a fresh pending one. md5 keeps the
-- index key bounded for arbitrarily long suggested_text. stage_id is part of
-- the key; a null stage_id (new_stage/new_faq) is treated as a distinct group
-- by md5(coalesce(...)) so those still dedupe on their text.
create unique index if not exists script_suggestions_pending_unique_idx
  on public.script_suggestions (
    bot_id,
    flow,
    coalesce(stage_id, -1),
    suggestion_type,
    md5(suggested_text)
  )
  where status = 'pending';

-- ============================================================
-- Grants — authenticated reads only; service_role does the bot's DML.
-- Revoke the auto-granted authenticated writes so table privilege matches
-- the admin-only RLS policy (same as text_stages).
-- ============================================================
grant select                         on public.script_suggestions to authenticated;
grant select, insert, update, delete on public.script_suggestions to service_role;
revoke insert, update, delete, truncate, references, trigger on public.script_suggestions from authenticated;

-- ============================================================
-- RLS — mirror text_stages: authenticated read; is_admin() write;
-- service_role full (bypasses RLS with its key).
-- ============================================================
alter table public.script_suggestions enable row level security;
alter table public.script_suggestions force  row level security;

create policy "script_suggestions_select_authenticated"
  on public.script_suggestions for select to authenticated using (true);
create policy "script_suggestions_insert_admin"
  on public.script_suggestions for insert to authenticated with check ((select public.is_admin()));
create policy "script_suggestions_update_admin"
  on public.script_suggestions for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "script_suggestions_delete_admin"
  on public.script_suggestions for delete to authenticated using ((select public.is_admin()));
