-- ============================================================
-- 0008_license_state.sql
-- Add the license_state companion column to leads.
--
-- license_state is a NEW field (not a repurposed one): the 2-letter
-- US state code that ISSUED the driver's license, normalized upper-
-- case (e.g. "CA"). It is always collected as its own explicit
-- question after the license number and is NOT assumed to match the
-- address state.
--
-- Idempotent: uses IF NOT EXISTS so re-running is safe.
-- ============================================================

alter table leads
  add column if not exists license_state text;
