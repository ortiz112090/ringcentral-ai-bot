import { logger } from "../logger";
import { config } from "../config";
import { RealtimeEngine } from "../ai/realtimeEngine";
import { onCallStarted, wrapUpCall } from "../callHandler";
import { transferToHuman } from "./telephony";
import { getCallState } from "../state/conversationStore";

/**
 * Bidirectional live-audio bridge between a RingCentral call and an OpenAI Realtime
 * session. This is where the latency win lives: caller audio is streamed INTO the model
 * as it arrives, and the model's audio deltas are streamed BACK OUT to the caller as
 * they arrive — nothing waits for a full turn to complete.
 *
 * ── HONEST CAVEAT ON RINGCENTRAL MEDIA ─────────────────────────────────────────────
 * RingCentral's Call Control API (answer / transfer / play) is fully supported here.
 * Getting a RAW BIDIRECTIONAL MEDIA STREAM for a call, however, depends on your specific
 * RingCentral product/account:
 *   - Some accounts expose media via RingCentral's Media Streaming / "Audio Stream" APIs
 *     or a SIP/WebRTC media path; availability and the exact transport differ by package.
 *   - This is NOT a simple public websocket like Twilio Media Streams, and it cannot be
 *     fully verified from this environment.
 * So the bridge is deliberately TRANSPORT-AGNOSTIC: the RingCentral media layer must
 *   (a) call `pushCallerAudio(callId, base64)` for each inbound audio chunk, and
 *   (b) attach an outbound sink via `attachMediaSink(callId, sink)` to receive the bot's
 *       audio chunks and write them to whatever RC media channel your account provides.
 * The audio codec is `config.openai.realtimeAudioFormat` (default g711_ulaw / mu-law
 * 8kHz), chosen to match typical telephony media and avoid resampling. If your RC media
 * feed is a different codec/sample rate, transcode at the sink/source boundary.
 * ────────────────────────────────────────────────────────────────────────────────────
 */

/** Outbound audio sink: the RC media layer implements this to play bot audio to the caller. */
export type MediaSink = (base64Audio: string) => void;

interface CallBridge {
  callId: string;
  partyId: string;
  engine: RealtimeEngine;
  sink: MediaSink | null;
  warnedNoSink: boolean;
}

const bridges = new Map<string, CallBridge>();

/**
 * Start a realtime bridge for a freshly-answered inbound call. Creates the call state +
 * DB record (via onCallStarted) and opens the Realtime session. Failure-tolerant: on any
 * error the caller is transferred to a human.
 *
 * `callId` is the RingCentral telephony session id (used as the call key everywhere).
 */
export async function startCallBridge(
  callId: string,
  partyId: string,
  callerNumber: string | null
): Promise<void> {
  try {
    const state = await onCallStarted(callId, callerNumber);

    const engine = new RealtimeEngine(state, {
      onBotAudio: (base64) => {
        const bridge = bridges.get(callId);
        if (!bridge) return;
        if (bridge.sink) {
          bridge.sink(base64);
        } else if (!bridge.warnedNoSink) {
          bridge.warnedNoSink = true;
          logger.warn(
            "Realtime bot audio produced but no RingCentral media sink attached — " +
              "wire attachMediaSink() to your account's media stream (see audioBridge.ts).",
            { callId }
          );
        }
      },
      onEscalate: async (reason) => {
        logger.info("Realtime escalation", { callId, reason });
        await escalateAndEnd(callId);
      },
      onOutcome: async (outcome) => {
        logger.info("Realtime terminal outcome", { callId, outcome });
        const state = getCallState(callId);
        if (state) await wrapUpCall(state, outcome);
        endCallBridge(callId);
      },
    });

    bridges.set(callId, { callId, partyId, engine, sink: null, warnedNoSink: false });
    await engine.start();
    logger.info("Realtime bridge started", {
      callId,
      audioFormat: config.openai.realtimeAudioFormat,
    });
  } catch (err) {
    logger.error("Failed to start realtime bridge; escalating", {
      callId,
      error: err instanceof Error ? err.message : String(err),
    });
    await escalateAndEnd(callId, partyId);
  }
}

/** Feed one inbound caller-audio chunk (base64, configured codec) into the model. */
export function pushCallerAudio(callId: string, base64Audio: string): void {
  bridges.get(callId)?.engine.appendCallerAudio(base64Audio);
}

/** Attach the outbound media sink that plays the bot's audio to the caller. */
export function attachMediaSink(callId: string, sink: MediaSink): void {
  const bridge = bridges.get(callId);
  if (bridge) bridge.sink = sink;
}

/** Tear down the bridge (call ended / transferred). Idempotent. */
export function endCallBridge(callId: string): void {
  const bridge = bridges.get(callId);
  if (!bridge) return;
  bridge.engine.close();
  bridges.delete(callId);
}

/**
 * Transfer the call to a human, finalize the record as escalated, and tear down.
 * Used both on explicit escalation and as the safety fallback on any bridge error.
 */
async function escalateAndEnd(callId: string, partyIdOverride?: string): Promise<void> {
  const bridge = bridges.get(callId);
  const partyId = bridge?.partyId ?? partyIdOverride;
  try {
    if (partyId) await transferToHuman(callId, partyId);
  } catch (err) {
    logger.error("Escalation transfer failed", {
      callId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const state = getCallState(callId);
  if (state) await wrapUpCall(state, "escalated");
  endCallBridge(callId);
}
