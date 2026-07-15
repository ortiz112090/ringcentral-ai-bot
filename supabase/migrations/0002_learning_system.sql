-- SR22 AI Voice Bot — Learning System schema
-- Retrieval-based learning (NOT fine-tuning): store tagged real-call examples and
-- human-approved "lessons", then inject approved lessons into the live system prompt.
-- Run AFTER 0001_init.sql, in the Supabase SQL editor or via `supabase db push`.

-- ---------- Optional: pgvector for semantic retrieval ----------
-- If pgvector is available on your Supabase instance (it is on all standard projects),
-- this enables embedding-based similarity search over learned_rules.situation_summary.
-- TRADEOFF: if this line fails on your instance, comment out this block AND the
-- `embedding` column + `match_learned_rules` function below. The app then falls back to
-- category-based lookup automatically (controlled by LEARNING_USE_PGVECTOR=false).
create extension if not exists vector;

-- ---------- Enums ----------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'training_source') then
    create type training_source as enum ('upload_audio', 'upload_transcript', 'live_call');
  end if;

  if not exists (select 1 from pg_type where typname = 'tag_type') then
    create type tag_type as enum ('good_example', 'bad_example');
  end if;

  if not exists (select 1 from pg_type where typname = 'rule_status') then
    create type rule_status as enum ('pending_review', 'approved', 'rejected');
  end if;
end$$;

-- ---------- training_calls ----------
-- A real call (uploaded audio, uploaded transcript, or a past live call) used as
-- learning material.
create table if not exists training_calls (
  id              bigint generated always as identity primary key,
  source          training_source not null,
  audio_url       text,                                  -- nullable; set if audio stored
  transcript      jsonb not null default '[]'::jsonb,    -- [{role:'caller'|'agent', text, timestamp?}]
  related_call_id text references calls (call_id) on delete set null, -- for source='live_call'
  uploaded_at     timestamptz not null default now(),
  notes           text
);

create index if not exists training_calls_source_idx on training_calls (source);

-- ---------- call_tags ----------
-- A human-marked moment within a training call: "this segment is a good/bad example
-- of handling <category>".
create table if not exists call_tags (
  id               bigint generated always as identity primary key,
  training_call_id bigint not null references training_calls (id) on delete cascade,
  segment_start    text,          -- turn index or timestamp (free-form for flexibility)
  segment_end      text,          -- nullable
  tag_type         tag_type not null,
  category         text not null, -- e.g. objection_shopping, objection_spouse, closing, opener, rapport, other
  caller_line      text,          -- snippet of what the caller said
  agent_line       text,          -- snippet of what the agent said
  tagged_by        text not null default 'user',
  created_at       timestamptz not null default now()
);

create index if not exists call_tags_training_call_id_idx on call_tags (training_call_id);
create index if not exists call_tags_category_idx on call_tags (category);

-- ---------- learned_rules ----------
-- A generalized, reusable lesson distilled from a tag (or written manually). Only
-- rules with status='approved' are ever injected into the live bot.
create table if not exists learned_rules (
  id                  bigint generated always as identity primary key,
  source_tag_id       bigint references call_tags (id) on delete set null, -- nullable if hand-written
  category            text not null,      -- matches call_tags.category
  situation_summary   text not null,      -- "when caller says X / is in situation Y"
  recommended_response text not null,     -- what to say/do
  avoid_response      text,               -- what NOT to say/do (for bad examples)
  status              rule_status not null default 'pending_review',
  embedding           vector(1536),       -- OpenAI text-embedding-3-small dims; null if pgvector unused
  created_at          timestamptz not null default now(),
  reviewed_at         timestamptz,
  reviewed_by         text
);

create index if not exists learned_rules_status_idx on learned_rules (status);
create index if not exists learned_rules_category_idx on learned_rules (category);

-- IVFFlat index for approximate nearest-neighbor search on the embedding. Requires
-- pgvector. Safe to skip if pgvector is unavailable (see note at top).
create index if not exists learned_rules_embedding_idx
  on learned_rules using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ---------- match_learned_rules RPC ----------
-- Returns the most semantically-similar APPROVED rules to a query embedding,
-- optionally filtered by category. Called from src/ai/retrieval.ts when pgvector is on.
-- If pgvector is unavailable, drop this function; the app falls back to category lookup.
create or replace function match_learned_rules(
  query_embedding vector(1536),
  match_count int default 3,
  filter_category text default null
)
returns table (
  id bigint,
  category text,
  situation_summary text,
  recommended_response text,
  avoid_response text,
  similarity float
)
language sql stable
as $$
  select
    lr.id,
    lr.category,
    lr.situation_summary,
    lr.recommended_response,
    lr.avoid_response,
    1 - (lr.embedding <=> query_embedding) as similarity
  from learned_rules lr
  where lr.status = 'approved'
    and lr.embedding is not null
    and (filter_category is null or lr.category = filter_category)
  order by lr.embedding <=> query_embedding
  limit match_count;
$$;
