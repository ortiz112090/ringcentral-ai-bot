import { logger } from "./logger";
import { getBotDecision } from "./ai/conversation";
import { synthesizeSpeech } from "./speech/openai";
import { transferToHuman } from "./ringcentral/telephony";
import {
  createCallRecord,
  finalizeCallRecord,
  findLeadByPhone,
  upsertLead,
} from "./db/queries";
import {
  CallState,
  createCallState,
  endCallState,
  getCallState,
  recordBotTurn,
  recordCallerTurn,
} from "./state/conversationStore";
import { CallOutcome } from "./db/types";

/**
 * Orchestrates a single call: initializes state on answer, processes each caller
 * utterance through Claude, synthesizes the reply, and escalates/finalizes as needed.
 *
 * Media transport (getting caller audio in and TTS audio out) is owned by the
 * RingCentral layer; this module is the brain that decides WHAT to say and when to
 * transfer or hang up. It never throws — any failure results in a safe escalation.
 */

export interface TurnResult {
  /** Words the bot should speak, already synthesized to audio bytes. */
  audio: Buffer | null;
  /** Plain text of what the bot said (for callers/logging). */
  text: string;
  /** True if the call should now be transferred to a human. */
  shouldTransfer: boolean;
  /** True if the call reached a terminal state and can be wrapped up. */
  ended: boolean;
}

/** Called when RingCentral tells us an inbound call has been answered by the bot. */
export async function onCallStarted(
  callId: string,
  callerNumber: string | null
): Promise<CallState> {
  const lead = callerNumber ? await findLeadByPhone(callerNumber) : null;
  const state = createCallState(callId, callerNumber, lead);
  await createCallRecord({
    call_id: callId,
    caller_number: callerNumber,
    started_at: state.startedAt,
    transcript: [],
  });
  logger.info("Call started", { callId, callerNumber, knownLead: Boolean(lead) });
  return state;
}

/**
 * Process one caller utterance (already transcribed to text) and produce the bot's
 * spoken reply. Returns synthesized audio plus control flags.
 */
export async function handleCallerUtterance(
  callId: string,
  callerText: string
): Promise<TurnResult> {
  const state = getCallState(callId);
  if (!state) {
    logger.warn("Utterance for unknown call; escalating", { callId });
    return {
      audio: null,
      text: "One moment while I connect you to a specialist.",
      shouldTransfer: true,
      ended: false,
    };
  }

  try {
    recordCallerTurn(state, callerText);
    const decision = await getBotDecision(state.lead, state.history);

    // Persist any lead fields Claude captured this turn.
    if (Object.keys(decision.lead_updates).length > 0 && state.callerNumber) {
      await upsertLead({
        phone_number: state.callerNumber,
        ...decision.lead_updates,
        status: decision.escalate ? "escalated" : "quoted",
        last_contacted_at: new Date().toISOString(),
      });
      state.lead = { ...(state.lead ?? { phone_number: state.callerNumber }), ...decision.lead_updates };
    }

    recordBotTurn(state, decision.say);
    state.stage = decision.stage;
    state.closeAttempts = decision.close_attempts;

    const audio = await safeSynthesize(decision.say);

    if (decision.escalate) {
      await wrapUp(state, "escalated");
      return { audio, text: decision.say, shouldTransfer: true, ended: true };
    }

    if (decision.outcome && decision.outcome !== "escalated") {
      await wrapUp(state, decision.outcome as CallOutcome);
      return { audio, text: decision.say, shouldTransfer: false, ended: true };
    }

    return { audio, text: decision.say, shouldTransfer: false, ended: false };
  } catch (err) {
    // Any unhandled error -> log outcome and escalate to a human. Never crash the call.
    logger.error("Unhandled error during turn; escalating", {
      callId,
      error: err instanceof Error ? err.message : String(err),
    });
    await wrapUp(state, "escalated");
    return {
      audio: await safeSynthesize(
        "Let me get you to a specialist who can help — one moment."
      ),
      text: "Let me get you to a specialist who can help — one moment.",
      shouldTransfer: true,
      ended: true,
    };
  }
}

/** Called when the call ends without a clean terminal outcome (caller hung up, etc.). */
export async function onCallEnded(
  callId: string,
  fallbackOutcome: CallOutcome = "abandoned"
): Promise<void> {
  const state = getCallState(callId);
  if (!state) return;
  await wrapUp(state, fallbackOutcome);
}

/** Transfer helper that always logs, used by the webhook layer on escalation. */
export async function escalateCall(
  callId: string,
  sessionId: string,
  partyId: string
): Promise<void> {
  try {
    await transferToHuman(sessionId, partyId);
  } catch (err) {
    logger.error("Escalation transfer failed", {
      callId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---- internals ----

async function wrapUp(state: CallState, outcome: CallOutcome): Promise<void> {
  await finalizeCallRecord(state.callId, {
    outcome,
    scriptStageReached: state.stage,
    transcript: state.transcript,
    endedAt: new Date().toISOString(),
  });
  endCallState(state.callId);
  logger.info("Call finalized", { callId: state.callId, outcome, stage: state.stage });
}

async function safeSynthesize(text: string): Promise<Buffer | null> {
  try {
    return await synthesizeSpeech(text);
  } catch (err) {
    logger.error("TTS synthesis failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
