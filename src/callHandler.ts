import { createHmac } from "node:crypto";
import { logger } from "./logger";
import { getBotDecision } from "./ai/conversation";
import { synthesizeSpeech } from "./speech/openai";
import { transferToHuman } from "./ringcentral/telephony";
import {
  createCallRecord,
  finalizeCallRecord,
  findLeadByPhone,
  upsertLead,
  getWebhookDestination,
} from "./db/queries";
import { BOT_ID } from "./db/remoteConfig";
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
 * utterance, and escalates/finalizes as needed.
 *
 * NOTE: live phone calls now run through the GPT-4o Realtime speech-to-speech engine
 * (see src/ai/realtimeEngine.ts + src/ringcentral/audioBridge.ts). The text turn path
 * below (getBotDecision → OpenAI chat → TTS) is retained for the SMS script. Both share
 * the same call-state, DB logging, and safe-escalation conventions. It never throws —
 * any failure results in a safe escalation.
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

    // Persist any lead fields the model captured this turn.
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

/**
 * Finalize a call: persist outcome + transcript and clear in-memory state. Exported so
 * the realtime audio bridge can finalize live calls the same way the text path does.
 */
export async function wrapUpCall(state: CallState, outcome: CallOutcome): Promise<void> {
  // Remove the in-memory state synchronously, BEFORE awaiting the DB write. A
  // concurrent duplicate teardown (e.g. the Twilio media-stream "stop" handler
  // racing the realtime engine's onOutcome callback) then finds no state via
  // getCallState and returns early — the primary dedupe against a double-finalize.
  // We keep our own `state` reference for the write below.
  endCallState(state.callId);
  const endedAt = new Date().toISOString();
  await finalizeCallRecord(state.callId, {
    outcome,
    scriptStageReached: state.stage,
    transcript: state.transcript,
    endedAt,
  });
  logger.info("Call finalized", { callId: state.callId, outcome, stage: state.stage });

  // Fire-and-forget: deliver captured lead data to the configured webhook. Never
  // awaited — a slow/failing endpoint must not delay teardown or affect DB writes.
  void dispatchLeadWebhook({
    bot_id: BOT_ID,
    call_id: state.callId,
    caller_number: state.callerNumber,
    outcome,
    started_at: state.startedAt,
    ended_at: endedAt,
    captured_data: state.capturedData,
  });

  // Missed-caller follow-up (SMS trigger 2): when a call ends UNSERVED — the caller
  // hung up before a quote, or we couldn't serve them — hand the lead to the SMS
  // bot. Served (closed_*) and human-handled (escalated) outcomes never text. The
  // SMS module is DYNAMICALLY imported only on a qualifying outcome, so the voice
  // path (and its tests) never load the SMS code for escalated/closed calls. The
  // trigger itself enforces the text kill switch, sub-toggle, opt-out, and quiet
  // hours, so this is a safe fire-and-forget.
  if (state.callerNumber && MISSED_CALL_OUTCOMES.has(outcome)) {
    const phone = state.callerNumber;
    const callId = state.callId;
    void import("./sms/smsService")
      .then(({ sendMissedCallText }) => sendMissedCallText({ phone }))
      .catch((err) => {
        logger.error("Missed-call SMS trigger failed", {
          callId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
}

/**
 * Call outcomes that mean the caller was NOT served and should get a follow-up
 * text. Deliberately excludes closed_pif/closed_installment (already sold) and
 * escalated (a human is taking over).
 */
const MISSED_CALL_OUTCOMES = new Set<CallOutcome>([
  "no_answer",
  "abandoned",
  "follow_up_needed",
]);

/** JSON body POSTed to a configured webhook lead-destination on call finalize. */
export interface LeadWebhookPayload {
  bot_id: string;
  call_id: string;
  caller_number: string | null;
  outcome: CallOutcome;
  started_at: string;
  ended_at: string;
  captured_data: Record<string, unknown>;
}

const WEBHOOK_TIMEOUT_MS = 5000;

/**
 * Deliver captured lead data to this bot's enabled webhook lead-destination, if
 * one exists. Single attempt, 5s timeout, no retries. When a config.secret is set,
 * the raw JSON body is signed with HMAC-SHA256 and the hex digest sent as
 * X-Signature. NEVER throws — any failure is logged at warn and swallowed so the
 * call flow and DB writes are unaffected.
 */
export async function dispatchLeadWebhook(payload: LeadWebhookPayload): Promise<void> {
  try {
    const destination = await getWebhookDestination(payload.bot_id);
    if (!destination) return;

    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (destination.secret) {
      headers["X-Signature"] = createHmac("sha256", destination.secret)
        .update(body)
        .digest("hex");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const res = await fetch(destination.url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        logger.warn("Lead webhook returned non-2xx", {
          callId: payload.call_id,
          status: res.status,
        });
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    logger.warn("Lead webhook dispatch failed", {
      callId: payload.call_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---- internals ----

async function wrapUp(state: CallState, outcome: CallOutcome): Promise<void> {
  await wrapUpCall(state, outcome);
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
