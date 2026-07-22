-- ============================================================
-- 0018_leads_contact_columns.sql
-- Leads contact columns for full home address, email, and start timeline
-- ("how soon do you need this active and filed") (PR I).
--
-- Today only DOB / license / name / zip / quotes / carrier are copied into
-- the leads table; address / email / start_timeline live only in
-- text_conversations.captured_data and are therefore invisible in the Leads
-- section. This migration surfaces all collected info on the leads row.
--
-- Adds (idempotent):
--   * leads.address        — full home mailing address (free text)
--   * leads.email          — contact email (normalized lowercase/trimmed)
--   * leads.start_timeline — how soon they need the SR22 active/filed (free text)
-- ============================================================

alter table public.leads
  add column if not exists address text,
  add column if not exists email text,
  add column if not exists start_timeline text;
