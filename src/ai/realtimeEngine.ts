import WebSocket from "ws";
import { config } from "../config";
import { logger } from "../logger";
import { buildRealtimeInstructions } from "./systemPrompt";
import { retrieveRelevantLessons } from "./retrieval";
import { CallState, recordBotTurn, recordCallerTurn } from "../state/conversationStore";
import { upsertLead, setRealtimeSessionId } from "../db/queries";
import { CallOutcome, Carrier } from "../db/types";

/**
 * OpenAI GPT-4o Realtime API engine — one instance per live phone call.
 *
 * Opens a WebSocket to the Realtime API, configures a speech-to-speech session with
 * the SR22 sales-script instructions + state-tracking tools, streams caller audio in,
 * and streams the model's audio deltas straight back out (never buffering a whole
 * response — that streaming is the core latency win over the old STT→Claude→TTS loop).
 *
 * SAFETY: every path is wrapped so a single call's failure never crashes the process.
 * On WebSocket error / model error we invoke the escalation callback so the caller is
 * handed to a human rather than left in silence.
 */

const REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
  config.openai.realtimeModel
)}`;

export interface RealtimeCallbacks {
  /** Push a chunk of the model's output audio (base64, in the configured codec) to RingCentral. */
  onBotAudio: (base64Audio: string) => void;
  /** The model decided to escalate — hand the call to a human. Called at most once. */
  onEscalate: (reason: string) => void | Promise<void>;
  /** The call reached a terminal outcome (non-escalation). Called at most once. */
  onOutcome: (outcome: CallOutcome) => void | Promise<void>;
}

/** Realtime session tool (function) definitions used purely for state tracking. */
const TOOLS = [
  {
    type: "function",
    name: "capture_lead_info",
    description:
      "Record any lead detail you learned this turn (name, ZIP, DOB, license number, quoted amounts, carrier). Call whenever you learn one.",
    parameters: {
      type: "object",
      properties: {
        first_name: { type: "string" },
        zip_code: { type: "string" },
        date_of_birth: { type: "string", description: "YYYY-MM-DD if known" },
        license_number: { type: "string" },
        quote_amount_pif: { type: "number" },
        quote_amount_monthly: { type: "number" },
        carrier: { type: "string", enum: ["progressive", "dairyland", "other"] },
      },
    },
  },
  {
    type: "function",
    name: "record_close_attempt",
    description:
      "Call at the START of each of the 5 close attempts, with its number (1-5), to track close discipline.",
    parameters: {
      type: "object",
      properties: {
        attempt_number: { type: "integer", minimum: 1, maximum: 5 },
      },
      required: ["attempt_number"],
    },
  },
  {
    type: "function",
    name: "escalate_to_human",
    description:
      "Escalate the call to a human specialist. Say a brief transfer line first, then call this.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string" } },
    },
  },
  {
    type: "function",
    name: "set_call_outcome",
    description:
      "Call once when the call reaches a terminal result.",
    parameters: {
      type: "object",
      properties: {
        outcome: {
          type: "string",
          enum: ["closed_pif", "closed_installment", "escalated", "follow_up_needed"],
        },
      },
      required: ["outcome"],
    },
  },
] as const;

export class RealtimeEngine {
  private ws: WebSocket | null = null;
  private closed = false;
  private escalated = false;
  private terminal = false;

  constructor(
    private readonly state: CallState,
    private readonly callbacks: RealtimeCallbacks
  ) {}

  /** Open the WebSocket and configure the session. Resolves once the socket is open. */
  async start(): Promise<void> {
    // Pull approved lessons for injection at session start (same additive learning
    // behavior as the text path). Retrieval never throws — worst case, empty list.
    let lessons = await retrieveRelevantLessons("");
    try {
      this.ws = new WebSocket(REALTIME_URL, {
        headers: {
          Authorization: `Bearer ${config.openai.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });
    } catch (err) {
      logger.error("Realtime WebSocket construction failed; escalating", {
        callId: this.state.callId,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.escalate("websocket_construction_failed");
      return;
    }

    const ws = this.ws;
    ws.on("open", () => {
      logger.info("Realtime session socket open", { callId: this.state.callId });
      this.sendSessionUpdate(lessons);
      // Kick off the opener: ask the model to speak first.
      this.send({ type: "response.create" });
    });
    ws.on("message", (data: WebSocket.RawData) => this.onMessage(data));
    ws.on("error", (err) => {
      logger.error("Realtime WebSocket error; escalating", {
        callId: this.state.callId,
        error: err instanceof Error ? err.message : String(err),
      });
      void this.escalate("websocket_error");
    });
    ws.on("close", () => {
      logger.info("Realtime session socket closed", { callId: this.state.callId });
    });
  }

  /** Forward a chunk of caller audio (base64, configured codec) into the model. */
  appendCallerAudio(base64Audio: string): void {
    if (this.closed || !this.isOpen()) return;
    this.send({ type: "input_audio_buffer.append", audio: base64Audio });
  }

  /** Close the WebSocket cleanly (call ended / transferred). Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  // ---- internals ----

  private isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.isOpen()) return;
    try {
      this.ws!.send(JSON.stringify(payload));
    } catch (err) {
      logger.error("Failed to send realtime event", {
        callId: this.state.callId,
        type: payload.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private sendSessionUpdate(lessons: Awaited<ReturnType<typeof retrieveRelevantLessons>>): void {
    const fmt = config.openai.realtimeAudioFormat;
    this.send({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        instructions: buildRealtimeInstructions(this.state.lead, lessons),
        voice: config.openai.realtimeVoice,
        input_audio_format: fmt,
        output_audio_format: fmt,
        // Let the model transcribe caller speech so we can log a transcript.
        input_audio_transcription: { model: "whisper-1" },
        // Server-side VAD handles turn-taking (barge-in + end-of-speech detection).
        turn_detection: { type: "server_vad" },
        tools: TOOLS,
        tool_choice: "auto",
      },
    });
  }

  private onMessage(data: WebSocket.RawData): void {
    let event: any;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return; // ignore non-JSON frames
    }

    switch (event.type) {
      case "session.created":
        if (event.session?.id) {
          void setRealtimeSessionId(this.state.callId, event.session.id);
        }
        break;

      // Streamed output audio — forward immediately, do NOT buffer.
      case "response.audio.delta":
        if (typeof event.delta === "string") this.callbacks.onBotAudio(event.delta);
        break;

      // Model's spoken line transcript (assistant side) — log when complete.
      case "response.audio_transcript.done":
        if (typeof event.transcript === "string" && event.transcript.trim()) {
          recordBotTurn(this.state, event.transcript.trim());
        }
        break;

      // Caller's speech transcript (input side) — log when complete.
      case "conversation.item.input_audio_transcription.completed":
        if (typeof event.transcript === "string" && event.transcript.trim()) {
          recordCallerTurn(this.state, event.transcript.trim());
        }
        break;

      // A tool/function call finished — dispatch to its handler.
      case "response.function_call_arguments.done":
        void this.handleToolCall(event.name, event.arguments, event.call_id);
        break;

      case "error":
        logger.error("Realtime API error event; escalating", {
          callId: this.state.callId,
          error: JSON.stringify(event.error ?? event),
        });
        void this.escalate("model_error");
        break;

      default:
        // Many event types (deltas, rate-limit info, etc.) are intentionally ignored.
        break;
    }
  }

  private async handleToolCall(
    name: string,
    rawArgs: string,
    callId: string | undefined
  ): Promise<void> {
    let args: any = {};
    try {
      args = rawArgs ? JSON.parse(rawArgs) : {};
    } catch {
      logger.warn("Unparseable tool arguments", { callId: this.state.callId, name });
    }

    try {
      switch (name) {
        case "capture_lead_info":
          await this.onCaptureLead(args);
          break;
        case "record_close_attempt":
          if (typeof args.attempt_number === "number") {
            this.state.closeAttempts = args.attempt_number;
            this.state.stage = `close_attempt_${args.attempt_number}`;
          }
          break;
        case "escalate_to_human":
          await this.escalate(typeof args.reason === "string" ? args.reason : "model_requested");
          break;
        case "set_call_outcome":
          await this.setOutcome(args.outcome);
          break;
        default:
          logger.warn("Unknown realtime tool call", { callId: this.state.callId, name });
      }
    } catch (err) {
      logger.error("Tool handler failed", {
        callId: this.state.callId,
        name,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Acknowledge the tool call so the model can continue the turn.
    if (callId) {
      this.send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({ ok: true }),
        },
      });
    }
  }

  private async onCaptureLead(args: Record<string, unknown>): Promise<void> {
    if (!this.state.callerNumber) return;
    const carrier =
      typeof args.carrier === "string" &&
      ["progressive", "dairyland", "other"].includes(args.carrier)
        ? (args.carrier as Carrier)
        : undefined;

    const updates = {
      first_name: str(args.first_name),
      zip_code: str(args.zip_code),
      date_of_birth: str(args.date_of_birth),
      license_number: str(args.license_number),
      quote_amount_pif: num(args.quote_amount_pif),
      quote_amount_monthly: num(args.quote_amount_monthly),
      carrier,
    };

    await upsertLead({
      phone_number: this.state.callerNumber,
      ...updates,
      status: "quoted",
      last_contacted_at: new Date().toISOString(),
    });
    this.state.lead = {
      ...(this.state.lead ?? { phone_number: this.state.callerNumber }),
      ...updates,
    };
  }

  private async escalate(reason: string): Promise<void> {
    if (this.escalated || this.terminal) return;
    this.escalated = true;
    this.state.stage = "escalation";
    await this.callbacks.onEscalate(reason);
  }

  private async setOutcome(outcome: unknown): Promise<void> {
    if (this.terminal || this.escalated) return;
    const valid: CallOutcome[] = [
      "closed_pif",
      "closed_installment",
      "escalated",
      "follow_up_needed",
    ];
    if (typeof outcome !== "string" || !valid.includes(outcome as CallOutcome)) return;
    if (outcome === "escalated") {
      await this.escalate("model_set_outcome_escalated");
      return;
    }
    this.terminal = true;
    await this.callbacks.onOutcome(outcome as CallOutcome);
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && !Number.isNaN(v) ? v : undefined;
}
