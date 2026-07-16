-- ============================================================
-- 20260716120100_bot_config.sql
-- Multi-row key/value config store for the bot.
-- Same RLS pattern as api_credentials.
-- ============================================================

create table public.bot_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

create trigger trg_bot_config_updated_at
  before update on public.bot_config
  for each row execute function public.set_updated_at();

-- ---- Grants ------------------------------------------------
grant select                         on public.bot_config to authenticated;
grant select, insert, update, delete on public.bot_config to service_role;
-- Supabase auto-grants broad DML to authenticated on new public tables;
-- revoke writes so table-level privilege matches the admin-only RLS policy.
revoke insert, update, delete, truncate, references, trigger on public.bot_config from authenticated;

-- ---- RLS ---------------------------------------------------
alter table public.bot_config enable row level security;
alter table public.bot_config force  row level security;

create policy "bot_config_select_authenticated"
  on public.bot_config
  for select to authenticated
  using (true);

create policy "bot_config_insert_admin"
  on public.bot_config
  for insert to authenticated
  with check ((select public.is_admin()));

create policy "bot_config_update_admin"
  on public.bot_config
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy "bot_config_delete_admin"
  on public.bot_config
  for delete to authenticated
  using ((select public.is_admin()));
