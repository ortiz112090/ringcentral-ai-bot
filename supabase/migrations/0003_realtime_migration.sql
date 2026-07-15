-- SR22 AI Voice Bot — Realtime (GPT-4o Realtime API) migration
-- Additive only. Does NOT alter or drop any existing column. Safe to run after
-- 0001_init.sql and 0002_learning_system.sql.
--
-- The live-call voice pipeline moved from a non-streaming Whisper→Claude→TTS loop to
-- OpenAI's GPT-4o Realtime API (speech-to-speech over WebSocket). Each live call now
-- opens a realtime session; we record its id on the call row for traceability/debugging.

alter table calls
  add column if not exists realtime_session_id text;

comment on column calls.realtime_session_id is
  'OpenAI Realtime API session id for the live speech-to-speech call (null for SMS/text or legacy calls).';
