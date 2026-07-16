-- SR22 AI Voice Bot — initial schema
-- Run in the Supabase SQL editor, or via `supabase db push` with the CLI.
-- NOTE: Supabase project ref hiqyfprmtipgrvwadqdb must be RESUMED (unpaused) first.

-- ---------- Enums ----------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'call_outcome') then
    create type call_outcome as enum (
      'closed_pif',
      'closed_installment',
      'escalated',
      'no_answer',
      'follow_up_needed',
      'abandoned'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'carrier_type') then
    create type carrier_type as enum ('progressive', 'dairyland', 'other');
  end if;

  if not exists (select 1 from pg_type where typname = 'lead_status') then
    create type lead_status as enum (
      'new',
      'contacted',
      'quoted',
      'closed',
      'escalated',
      'lost'
    );
  end if;
end$$;

-- ---------- calls ----------
-- One row per inbound call handled by the bot.
create table if not exists calls (
  call_id               text primary key,          -- RingCentral telephony session id
  caller_number         text,
  started_at            timestamptz not null default now(),
  ended_at              timestamptz,
  outcome               call_outcome,
  script_stage_reached  text,                       -- last stage of the sales script reached
  transcript            jsonb not null default '[]'::jsonb, -- [{role, text, timestamp}]
  created_at            timestamptz not null default now()
);

create index if not exists calls_caller_number_idx on calls (caller_number);
create index if not exists calls_started_at_idx on calls (started_at desc);

-- ---------- leads ----------
-- One row per prospective customer, keyed by phone number.
-- SENSITIVE: license_number is PII. It is collected only for quoting and is NEVER
-- used to run an MVR (Motor Vehicle Record) check — that is explicitly forbidden.
-- Consider Supabase Vault / pgcrypto or column encryption before production use.
create table if not exists leads (
  phone_number         text primary key,
  first_name           text,
  zip_code             text,
  date_of_birth        date,
  license_number       text,                        -- SENSITIVE PII (see note above)
  quote_amount_pif     numeric(10,2),               -- paid-in-full 6-month quote
  quote_amount_monthly numeric(10,2),               -- monthly installment quote
  carrier              carrier_type,
  status               lead_status not null default 'new',
  last_contacted_at    timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists leads_status_idx on leads (status);

-- ---------- call_transcripts (optional turn-by-turn table) ----------
-- The `calls.transcript` JSONB column is the primary store; this normalized table
-- is optional for finer-grained QA queries. Both are kept in sync by the app if used.
create table if not exists call_transcripts (
  id          bigint generated always as identity primary key,
  call_id     text not null references calls (call_id) on delete cascade,
  turn_index  int not null,
  speaker     text not null check (speaker in ('caller', 'bot')),
  text        text not null,
  created_at  timestamptz not null default now()
);

create index if not exists call_transcripts_call_id_idx on call_transcripts (call_id);

-- ---------- updated_at trigger for leads ----------
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists leads_set_updated_at on leads;
create trigger leads_set_updated_at
  before update on leads
  for each row execute function set_updated_at();
