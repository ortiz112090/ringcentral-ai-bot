-- ============================================================
-- 0009_texting_bot.sql
-- SMS texting-bot add-on. Three new tables (text_conversations,
-- text_messages, text_stages) plus the bot_config columns the SMS
-- path reads, and a Text Flow seed for the primary bot adapted from
-- the current SR22 call script.
--
-- Multi-tenant: every table carries bot_id and is scoped by it in
-- the app (loadRemoteConfig / smsQueries). RLS + grants mirror the
-- api_credentials / bot_config convention (admin-only writes via
-- public.is_admin(); service_role does the bot's own DML).
--
-- Idempotent: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / ON CONFLICT
-- so re-running is safe. Executes NOTHING automatically — apply via
-- the Supabase SQL editor or `supabase db push`.
-- ============================================================

-- ---------- Enums ----------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'text_conversation_status') then
    create type text_conversation_status as enum (
      'active',
      'completed',
      'escalated',
      'opted_out'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'text_trigger') then
    create type text_trigger as enum (
      'inbound',
      'missed_call',
      'web_lead'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'text_direction') then
    create type text_direction as enum ('inbound', 'outbound');
  end if;
end$$;

-- ============================================================
-- bot_config columns (columnar per-tenant config table)
-- ============================================================
alter table public.bot_config
  add column if not exists text_enabled              boolean,
  add column if not exists text_number               text,
  add column if not exists text_model                text,
  add column if not exists business_name             text,
  add column if not exists missed_call_text_enabled  boolean,
  add column if not exists web_lead_text_enabled      boolean,
  add column if not exists timezone                  text;

-- ============================================================
-- text_stages — dashboard-authored SMS "Text Flow" script stages.
-- Same shape as script_stages but a SEPARATE table so the SMS flow
-- can diverge from the voice call script. The bot reads only ACTIVE
-- rows for its bot_id, ordered by stage_order.
-- ============================================================
create table if not exists public.text_stages (
  id           bigint generated always as identity primary key,
  bot_id       uuid not null,
  stage_key    text not null,
  stage_order  int,
  stage_type   text not null,   -- opener | qualify | data_collection | quote | close | objection | fallback
  title        text,
  script_text  text,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (bot_id, stage_key)
);

create index if not exists text_stages_bot_active_order_idx
  on public.text_stages (bot_id, active, stage_order);

drop trigger if exists trg_text_stages_updated_at on public.text_stages;
create trigger trg_text_stages_updated_at
  before update on public.text_stages
  for each row execute function public.set_updated_at();

-- ============================================================
-- text_conversations — one row per (bot, phone) engagement thread.
-- opted_out status is the sticky opt-out flag checked before every
-- outbound send.
-- ============================================================
create table if not exists public.text_conversations (
  id               uuid primary key default gen_random_uuid(),
  bot_id           uuid not null,
  phone_number     text not null,
  status           text_conversation_status not null default 'active',
  trigger          text_trigger not null,
  captured_data    jsonb not null default '{}'::jsonb,
  last_message_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists text_conversations_bot_phone_idx
  on public.text_conversations (bot_id, phone_number, created_at desc);
create index if not exists text_conversations_bot_status_idx
  on public.text_conversations (bot_id, status);

drop trigger if exists trg_text_conversations_updated_at on public.text_conversations;
create trigger trg_text_conversations_updated_at
  before update on public.text_conversations
  for each row execute function public.set_updated_at();

-- ============================================================
-- text_messages — one row per inbound/outbound SMS in a conversation.
-- ============================================================
create table if not exists public.text_messages (
  id               bigint generated always as identity primary key,
  bot_id           uuid not null,
  conversation_id  uuid not null references public.text_conversations (id) on delete cascade,
  direction        text_direction not null,
  body             text not null,
  created_at       timestamptz not null default now()
);

create index if not exists text_messages_convo_idx
  on public.text_messages (conversation_id, created_at desc);
create index if not exists text_messages_bot_idx
  on public.text_messages (bot_id);

-- ============================================================
-- Grants — authenticated reads only; service_role does the bot's DML.
-- Revoke the auto-granted authenticated writes so table privilege
-- matches the admin-only RLS policy (same as bot_config).
-- ============================================================
grant select                         on public.text_stages        to authenticated;
grant select, insert, update, delete on public.text_stages        to service_role;
revoke insert, update, delete, truncate, references, trigger on public.text_stages from authenticated;

grant select                         on public.text_conversations to authenticated;
grant select, insert, update, delete on public.text_conversations to service_role;
revoke insert, update, delete, truncate, references, trigger on public.text_conversations from authenticated;

grant select                         on public.text_messages      to authenticated;
grant select, insert, update, delete on public.text_messages      to service_role;
revoke insert, update, delete, truncate, references, trigger on public.text_messages from authenticated;

-- ============================================================
-- RLS — admin-only writes (dashboard), authenticated reads. The bot
-- itself uses the service_role key, which bypasses RLS.
-- ============================================================
alter table public.text_stages        enable row level security;
alter table public.text_stages        force  row level security;
alter table public.text_conversations enable row level security;
alter table public.text_conversations force  row level security;
alter table public.text_messages      enable row level security;
alter table public.text_messages      force  row level security;

-- text_stages policies
create policy "text_stages_select_authenticated"
  on public.text_stages for select to authenticated using (true);
create policy "text_stages_insert_admin"
  on public.text_stages for insert to authenticated with check ((select public.is_admin()));
create policy "text_stages_update_admin"
  on public.text_stages for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "text_stages_delete_admin"
  on public.text_stages for delete to authenticated using ((select public.is_admin()));

-- text_conversations policies
create policy "text_conversations_select_authenticated"
  on public.text_conversations for select to authenticated using (true);
create policy "text_conversations_insert_admin"
  on public.text_conversations for insert to authenticated with check ((select public.is_admin()));
create policy "text_conversations_update_admin"
  on public.text_conversations for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "text_conversations_delete_admin"
  on public.text_conversations for delete to authenticated using ((select public.is_admin()));

-- text_messages policies
create policy "text_messages_select_authenticated"
  on public.text_messages for select to authenticated using (true);
create policy "text_messages_insert_admin"
  on public.text_messages for insert to authenticated with check ((select public.is_admin()));
create policy "text_messages_update_admin"
  on public.text_messages for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "text_messages_delete_admin"
  on public.text_messages for delete to authenticated using ((select public.is_admin()));

-- ============================================================
-- Text Flow seed (primary bot 00000000-0000-0000-0000-000000000001)
-- Adapted from the current SR22 call script for SMS: short, one
-- question per text, verbatim stage lines. Placeholders (Client's
-- Name)/(Agent Name) are substituted by the prompt builder at runtime.
-- ON CONFLICT keeps re-runs idempotent while refreshing the copy.
-- ============================================================
insert into public.text_stages (bot_id, stage_key, stage_order, stage_type, title, script_text, active)
values
  ('00000000-0000-0000-0000-000000000001', 'opener', 1, 'opener', 'Opener',
   'Hi (Client''s Name), this is (Agent Name). I saw you were looking into getting an SR22 filed — has anyone helped you with that yet?', true),
  ('00000000-0000-0000-0000-000000000001', 'qualify', 2, 'qualify', 'Qualify',
   'No problem, I can take care of that for you. How soon do you need it filed?', true),
  ('00000000-0000-0000-0000-000000000001', 'collect_zip', 3, 'data_collection', 'Collect ZIP',
   'Great — first, what''s the ZIP code where you live?', true),
  ('00000000-0000-0000-0000-000000000001', 'collect_dob', 4, 'data_collection', 'Collect Date of Birth',
   'Thanks! And what''s your date of birth — month, day, and year?', true),
  ('00000000-0000-0000-0000-000000000001', 'collect_license', 5, 'data_collection', 'Collect License Number',
   'Perfect. What''s your driver''s license number? (no dashes or spaces)', true),
  ('00000000-0000-0000-0000-000000000001', 'collect_license_state', 6, 'data_collection', 'Collect License State',
   'And which state issued that license?', true),
  ('00000000-0000-0000-0000-000000000001', 'quote', 7, 'quote', 'Present Quote',
   'Awesome — let me pull the best rate for you. I can file your SR22 today with Progressive if you pay in full; want me to lock that in?', true),
  ('00000000-0000-0000-0000-000000000001', 'objection', 8, 'objection', 'Price Objection',
   'Mhm, no problem! If paying in full is a lot right now, Dairyland has a monthly option that still gets your SR22 filed today. Would that work better?', true),
  ('00000000-0000-0000-0000-000000000001', 'close', 9, 'close', 'Close',
   'Want me to get that filed for you right now? If you''d rather talk it through, I can have a licensed specialist call you.', true),
  ('00000000-0000-0000-0000-000000000001', 'fallback', 10, 'fallback', 'Fallback',
   'I want to make sure you''re taken care of — let me connect you with one of our specialists who can help.', true)
on conflict (bot_id, stage_key) do update set
  stage_order = excluded.stage_order,
  stage_type  = excluded.stage_type,
  title       = excluded.title,
  script_text = excluded.script_text,
  active      = excluded.active,
  updated_at  = now();
