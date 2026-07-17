import { ChatTurn } from "../ai/conversation";
import { LeadRecord, TranscriptTurn } from "../db/types";
import { insertCallTranscriptTurn } from "../db/queries";

/**
 * In-memory per-call conversation state, keyed by RingCentral telephony session id.
 * Simple and adequate for a single-instance v1. If you scale to multiple Render
 * instances, move this to Redis or persist to Supabase between turns.
 */

export interface CallState {
  callId: string;
  callerNumber: string | null;
  lead: LeadRecord | null;
  history: ChatTurn[]; // chat history for the text path (caller = user, bot = assistant)
  transcript: TranscriptTurn[]; // human-readable turn log for QA
  stage: string;
  closeAttempts: number;
  startedAt: string;
}

const store = new Map<string, CallState>();

export function createCallState(
  callId: string,
  callerNumber: string | null,
  lead: LeadRecord | null
): CallState {
  const state: CallState = {
    callId,
    callerNumber,
    lead,
    history: [],
    transcript: [],
    stage: "opener",
    closeAttempts: 0,
    startedAt: new Date().toISOString(),
  };
  store.set(callId, state);
  return state;
}

export function getCallState(callId: string): CallState | undefined {
  return store.get(callId);
}

export function recordCallerTurn(state: CallState, text: string): void {
  const ts = new Date().toISOString();
  state.history.push({ role: "user", content: text });
  state.transcript.push({ role: "caller", text, timestamp: ts });
  persistTurn(state, "caller", text);
}

export function recordBotTurn(state: CallState, text: string): void {
  const ts = new Date().toISOString();
  // We store only the spoken line as assistant context (not the JSON control block),
  // keeping history clean and token-cheap.
  state.history.push({ role: "assistant", content: text });
  state.transcript.push({ role: "bot", text, timestamp: ts });
  persistTurn(state, "bot", text);
}

/**
 * Fire-and-forget incremental insert of the turn just pushed. turn_index is the
 * position in state.transcript (0-based), so it's sequential per call across both
 * the text and realtime paths. Never awaited/thrown — the DB write must not block
 * or crash the live call; the full transcript is still persisted at call end.
 */
function persistTurn(state: CallState, speaker: TranscriptTurn["role"], text: string): void {
  const turnIndex = state.transcript.length - 1;
  void insertCallTranscriptTurn({ callId: state.callId, turnIndex, speaker, text });
}

export function endCallState(callId: string): void {
  store.delete(callId);
}
