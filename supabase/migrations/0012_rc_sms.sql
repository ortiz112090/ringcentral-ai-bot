-- ============================================================
-- 0012_rc_sms.sql
-- RingCentral SMS channel add-on (PR C). Texting bots now receive
-- and answer SMS through BOTH Twilio and RingCentral, sharing the
-- same brain (smsEngine), storage (text_conversations/text_messages),
-- and compliance layer. This migration adds the columns that let a
-- single conversation/message pipeline track which channel a thread
-- lives on and dedupe inbound RingCentral deliveries.
--
-- Multi-tenant: no new tables; the existing text_* tables already
-- carry bot_id and are scoped by it in the app (smsQueries).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + guarded constraint/index
-- creation so re-running is safe. Executes NOTHING automatically —
-- apply via the Supabase SQL editor or `supabase db push`.
-- ============================================================

-- ============================================================
-- text_conversations.channel — which provider this thread lives on.
-- Existing rows default to 'twilio' (the only pre-RC channel), so the
-- reply-channel routing keeps working for in-flight conversations.
-- ============================================================
alter table public.text_conversations
  add column if not exists channel text not null default 'twilio';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'text_conversations_channel_check'
  ) then
    alter table public.text_conversations
      add constraint text_conversations_channel_check
      check (channel in ('twilio', 'ringcentral'));
  end if;
end$$;

-- ============================================================
-- text_messages.provider_message_id — the upstream provider's message
-- id (RingCentral message-store id). Nullable: Twilio inbound/outbound
-- and RC outbound rows may leave it null; it exists so an inbound RC
-- delivery can be deduped (RC may redeliver the same webhook event).
-- ============================================================
alter table public.text_messages
  add column if not exists provider_message_id text;

-- Partial index makes the dedupe existence check (bot_id + provider id)
-- cheap; partial so null ids (the common case) don't bloat the index.
create index if not exists text_messages_provider_msg_id_idx
  on public.text_messages (bot_id, provider_message_id)
  where provider_message_id is not null;

-- ============================================================
-- bot_config.rc_sms_number — the RingCentral number this bot texts
-- from / receives on. Null = RingCentral texting is off for this bot
-- (Twilio texting is unaffected). Non-secret per-tenant column, read
-- fresh per message like the other bot_config settings.
-- ============================================================
alter table public.bot_config
  add column if not exists rc_sms_number text;
