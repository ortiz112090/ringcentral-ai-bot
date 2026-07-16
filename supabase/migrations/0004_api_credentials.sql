-- ============================================================
-- 20260716120000_api_credentials.sql
-- Provider API credentials table + shared helpers.
-- ============================================================

-- ---- Shared trigger: auto-update updated_at ----------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---- Helper: is the current JWT an admin? ------------------
-- Reads only from the signed JWT (app_metadata is server-set and
-- tamper-proof). Wrap in (select ...) at RLS call sites for perf.
create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin',
    false
  );
$$;

-- ---- Table -------------------------------------------------
create table public.api_credentials (
  provider    text primary key
              check (provider in ('render','ringcentral','twilio','openai-tts','elevenlabs')),
  credentials jsonb not null,
  updated_at  timestamptz not null default now()
);

create trigger trg_api_credentials_updated_at
  before update on public.api_credentials
  for each row execute function public.set_updated_at();

-- ---- Grants ------------------------------------------------
-- RLS governs row access; grants govern table-level privilege.
grant select                         on public.api_credentials to authenticated;
grant select, insert, update, delete on public.api_credentials to service_role;
-- Supabase auto-grants broad DML to authenticated on new public tables;
-- revoke writes so table-level privilege matches the admin-only RLS policy.
revoke insert, update, delete, truncate, references, trigger on public.api_credentials from authenticated;

-- ---- RLS ---------------------------------------------------
alter table public.api_credentials enable row level security;
alter table public.api_credentials force  row level security;

-- authenticated: read-only
create policy "api_credentials_select_authenticated"
  on public.api_credentials
  for select
  to authenticated
  using (true);

-- admins only: write
create policy "api_credentials_insert_admin"
  on public.api_credentials
  for insert
  to authenticated
  with check ((select public.is_admin()));

create policy "api_credentials_update_admin"
  on public.api_credentials
  for update
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy "api_credentials_delete_admin"
  on public.api_credentials
  for delete
  to authenticated
  using ((select public.is_admin()));
