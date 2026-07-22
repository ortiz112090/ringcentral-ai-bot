-- ============================================================
-- 0019_declined_status.sql
-- Interest gate: add a 'declined' text_conversation_status (PR J).
--
-- After the opener, the lead's first reply is classified before any data
-- collection. A clearly NEGATIVE reply (not interested / doesn't need it /
-- "no") — but NOT an explicit stop-texting opt-out — ends the conversation
-- via mark_not_interested. Such conversations are marked 'declined' so the
-- campaign worker stops re-contacting them, mirroring the sticky 'opted_out'
-- flow. Explicit opt-outs still use 'opted_out' (unchanged).
--
-- Idempotent: `add value if not exists`. Run in the Supabase SQL editor or
-- via `supabase db push` — NOT executed automatically by the app.
-- ============================================================

alter type text_conversation_status add value if not exists 'declined';
