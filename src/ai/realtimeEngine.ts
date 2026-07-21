import WebSocket from "ws";
import { config, resolveEffectiveConfig, type EffectiveConfig } from "../config";
import { BOT_ID } from "../db/remoteConfig";
import { logger } from "../logger";
import { buildRealtimeInstructions } from "./systemPrompt";
import { retrieveRelevantLessons } from "./retrieval";
import { CallState, recordBotTurn, recordCallerTurn } from "../state/conversationStore";
import {
  upsertLead,
  setRealtimeSessionId,
  getLeadFields,
  getScriptStages,
  getScriptConstraints,
  mergeCapturedData,
  type LeadFieldRow,
  type ScriptStageRow,
  type ScriptConstraintRow,
} from "../db/queries";
import { CallOutcome } from "../db/types";
import {
  FALLBACK_CAPTURE_LEAD_TOOL,
  buildCaptureLeadTool,
  buildLeadColumnUpdates,
  validateCapturedValues,
} from "../leads/capture";

// Re-export the shared lead-capture surface so existing importers (and tests) that
// pull these from "./realtimeEngine" keep working after the refactor into
// ../leads/capture. Both channels (voice + SMS) now share one implementation.
export {
  buildCaptureLeadTool,
  validateCapturedValues,
  type CapturedValidation,
} from "../leads/capture";

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
  /**
   * Server VAD detected the caller started speaking over the bot (barge-in).
   * Transports that buffer outbound audio (e.g. Twilio Media Streams) use this to
   * flush their play buffer so the bot stops talking immediately. Optional.
   */
  onBargeIn?: () => void;
  /** The call reached a terminal outcome (non-escalation). Called at most once. */
  onOutcome: (outcome: CallOutcome) => void | Promise<void>;
}

/**
 * Realtime session tools OTHER than capture_lead_info. These stay hardcoded (the
 * capture tool is built dynamically from lead_fields; see buildCaptureLeadTool).
 */
const STATIC_TOOLS = [
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


/**
 * Vocabulary hint for the input transcriber. Deliberately a short, plain
 * natural-language SENTENCE (not a keyword list, and no per-tenant lead-field
 * label list): a terse "term dump" prompt made the transcription model echo the
 * prompt VERBATIM into caller transcript rows when the caller audio was brief or
 * noisy. A fluent sentence biases toward the SR22/PII shapes without inviting the
 * model to parrot it back. Kept short on purpose (see TRANSCRIPTION_PROMPT_MAX).
 */
export const STATIC_TRANSCRIPTION_VOCAB =
  "The caller is discussing SR22 auto insurance quotes and may mention carriers like Progressive or Dairyland, plus details such as their name, ZIP code, birth date, and driver's license number.";

/** Keep the transcription prompt short to further discourage prompt echo. */
const TRANSCRIPTION_PROMPT_MAX = 300;

/**
 * Build the GA `session.audio.input.transcription` object: the configured model,
 * English, and the static natural-language vocabulary sentence. The per-tenant
 * lead_field labels are NO LONGER appended — that keyword-list suffix is what made
 * the transcriber echo the prompt into transcripts. `leadFields` is retained in the
 * signature for call-site compatibility but intentionally unused. Pure + exported so
 * it's unit-testable; the prompt is truncated to <= TRANSCRIPTION_PROMPT_MAX chars.
 */
export function buildTranscriptionConfig(
  model: string,
  _leadFields: LeadFieldRow[]
): { model: string; language: string; prompt: string } {
  let prompt = STATIC_TRANSCRIPTION_VOCAB;
  if (prompt.length > TRANSCRIPTION_PROMPT_MAX) {
    prompt = prompt.slice(0, TRANSCRIPTION_PROMPT_MAX).trimEnd();
  }
  return { model, language: "en", prompt };
}

/**
 * Supported GA realtime voices. session.update.audio.output.voice must be one of
 * these; anything else gets the connection rejected. Kept lowercase for a
 * case-insensitive match against the per-call effective voice.
 */
export const SUPPORTED_REALTIME_VOICES = [
  "marin",
  "cedar",
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
] as const;

/** Fallback voice when the configured one is unsupported/empty. */
const DEFAULT_REALTIME_VOICE = "cedar";

/**
 * Validate the per-call effective realtime voice against the supported GA list
 * (case-insensitive). Returns the normalized (lowercase) supported voice, or the
 * "cedar" fallback — logging a warning — when it's empty/unsupported so a stale or
 * bad bot_config value can never get the realtime session rejected.
 */
export function resolveRealtimeVoice(voice: string | null | undefined): string {
  const normalized = typeof voice === "string" ? voice.trim().toLowerCase() : "";
  if (
    normalized !== "" &&
    (SUPPORTED_REALTIME_VOICES as readonly string[]).includes(normalized)
  ) {
    return normalized;
  }
  logger.warn("Unsupported realtime voice; falling back", {
    requested: voice ?? null,
    fallback: DEFAULT_REALTIME_VOICE,
  });
  return DEFAULT_REALTIME_VOICE;
}

/**
 * Build the GA server-VAD turn_detection object from the effective voice config.
 * A higher threshold and longer silence window make the bot far less likely to
 * treat phone-line breath/background noise as the caller taking a turn.
 */
export function buildTurnDetection(voice: EffectiveConfig["voice"]): Record<string, unknown> {
  return {
    type: "server_vad",
    threshold: voice.vadThreshold,
    silence_duration_ms: voice.vadSilenceMs,
    prefix_padding_ms: voice.vadPrefixPaddingMs,
  };
}

export class RealtimeEngine {
  private ws: WebSocket | null = null;
  private closed = false;
  private escalated = false;
  private terminal = false;
  /** capture_lead_info tool built from lead_fields (or the fallback). */
  private captureLeadTool: Record<string, unknown> = { ...FALLBACK_CAPTURE_LEAD_TOOL };
  /** Active lead_fields for this call — used to validate captured values server-side. */
  private leadFields: LeadFieldRow[] = [];
  /** server-VAD turn_detection built from the effective voice config. */
  private turnDetection: Record<string, unknown> = { type: "server_vad" };
  /** input transcription config (model + language + vocabulary prompt). */
  private transcriptionConfig: Record<string, unknown> = buildTranscriptionConfig(
    "gpt-4o-transcribe",
    []
  );
  /** When false, caller speech does not flush/interrupt the bot's outgoing audio. */
  private bargeInEnabled = true;
  /** Per-call effective realtime voice (validated GA voice; defaults to fallback). */
  private realtimeVoice: string = DEFAULT_REALTIME_VOICE;
  /** Per-call effective realtime output speed (clamped to [0.25, 1.5]; default 1.0). */
  private realtimeSpeed = 1.0;
  /** Active dashboard script stages for this bot (empty → hardcoded fallback script). */
  private scriptStages: ScriptStageRow[] = [];
  /** Active dashboard script constraints for this bot (rendered into HARD RULES). */
  private scriptConstraints: ScriptConstraintRow[] = [];

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
      // Resolve the OpenAI key per-tenant (env + this bot's Supabase credentials),
      // not the raw env baseline which is empty for non-primary tenants.
      const effective = await resolveEffectiveConfig();
      this.turnDetection = buildTurnDetection(effective.voice);
      this.bargeInEnabled = effective.voice.bargeInEnabled;
      // Store the per-call effective voice (validated against the supported GA
      // voices; falls back to "cedar" on empty/unsupported) so session.update sends
      // THIS voice rather than the static env-only module config.
      this.realtimeVoice = resolveRealtimeVoice(effective.realtimeVoice);
      // Per-call output speaking rate (env-first, then bot_config.voice_speed),
      // already clamped to OpenAI's supported [0.25, 1.5] in resolveEffectiveConfig.
      this.realtimeSpeed = effective.realtimeSpeed;

      // Build the capture_lead_info schema from this bot's active lead_fields. On any
      // failure/empty result we fall back to the hardcoded schema so the call flow is
      // never broken (getLeadFields already returns [] on query error; the try/catch
      // also covers an unexpected throw).
      let leadFields: LeadFieldRow[] = [];
      try {
        leadFields = await getLeadFields(BOT_ID);
      } catch (err) {
        logger.warn("lead_fields load failed; using fallback capture schema", {
          callId: this.state.callId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.leadFields = leadFields;
      this.captureLeadTool = buildCaptureLeadTool(leadFields);

      // Load the dashboard-authored script (stages + constraints) so live calls
      // follow the "Training & Learning" script instead of the hardcoded one. Both
      // queries return [] on error, so an empty result simply keeps the hardcoded
      // fallback script; a failure never breaks the call.
      this.scriptStages = await getScriptStages(BOT_ID);
      this.scriptConstraints = await getScriptConstraints(BOT_ID);
      // Reuse the same leadFields to bias the input transcriber toward this bot's
      // field labels on top of the static SR22 vocabulary.
      this.transcriptionConfig = buildTranscriptionConfig(
        effective.openai.transcribeModel,
        leadFields
      );

      const apiKey = effective.openai.apiKey;
      if (!apiKey) {
        throw new Error(
          `OpenAI API key missing for tenant BOT_ID=${BOT_ID}; cannot open realtime session`
        );
      }
      // GA interface: the "OpenAI-Beta: realtime=v1" header is gone — sending it now
      // gets the connection rejected with beta_api_shape_disabled.
      this.ws = new WebSocket(REALTIME_URL, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
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
    const audioFormat = gaAudioFormat(config.openai.realtimeAudioFormat);
    // GA session shape: session.type is required, and audio config is nested under
    // session.audio.{input,output} with the format as an object (not the old flat
    // input_audio_format/output_audio_format strings). Output modalities are omitted
    // so the GA default (audio + text) applies. See migration notes in the PR.
    this.send({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: buildRealtimeInstructions(
          this.state.lead,
          lessons,
          this.scriptStages,
          this.scriptConstraints,
          this.state.outbound
        ),
        audio: {
          input: {
            format: audioFormat,
            // Transcribe caller speech (gpt-4o-transcribe + English + SR22/lead-field
            // vocabulary hint) — far more accurate than whisper-1 on 8kHz phone audio.
            transcription: this.transcriptionConfig,
            // OpenAI server-side input noise reduction. near_field suits a handset/
            // headset caller close to the mic (vs far_field for speakerphone/room).
            noise_reduction: { type: "near_field" },
            // Server-side VAD handles turn-taking (barge-in + end-of-speech detection),
            // tuned per-tenant from bot_config so phone-line breath/noise doesn't cut
            // the bot off. See buildTurnDetection.
            turn_detection: this.turnDetection,
          },
          output: {
            format: audioFormat,
            voice: this.realtimeVoice,
            speed: this.realtimeSpeed,
          },
        },
        tools: [this.captureLeadTool, ...STATIC_TOOLS],
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
      // GA renamed response.audio.delta → response.output_audio.delta.
      case "response.output_audio.delta":
        if (typeof event.delta === "string") this.callbacks.onBotAudio(event.delta);
        break;

      // Caller began speaking (server VAD) — signal barge-in so the transport can
      // flush any already-sent bot audio it is still playing. When barge-in is
      // disabled we deliberately do NOT flush/interrupt the bot's outgoing audio;
      // the model still manages turns naturally via server VAD.
      case "input_audio_buffer.speech_started":
        if (this.bargeInEnabled) this.callbacks.onBargeIn?.();
        break;

      // Model's spoken line transcript (assistant side) — log when complete.
      // GA renamed response.audio_transcript.done → response.output_audio_transcript.done.
      case "response.output_audio_transcript.done":
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

      case "error": {
        // A stray response.create sent while a response is still in flight comes back
        // as this non-fatal error. It is expected on the auto-continue-after-tool path
        // (see handleToolCall) — log at warn and ignore rather than escalating the call.
        const errCode = event.error?.code ?? event.code;
        if (errCode === "conversation_already_has_active_response") {
          logger.warn("Realtime response already active; ignoring extra response.create", {
            callId: this.state.callId,
          });
          break;
        }
        logger.error("Realtime API error event; escalating", {
          callId: this.state.callId,
          error: JSON.stringify(event.error ?? event),
        });
        void this.escalate("model_error");
        break;
      }

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

    // Default acknowledgement; capture_lead_info overrides it with a validation-aware
    // output so the model knows which values were saved vs. rejected (and re-asks).
    let output: Record<string, unknown> = { ok: true };
    try {
      switch (name) {
        case "capture_lead_info":
          output = await this.onCaptureLead(args);
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
          output: JSON.stringify(output),
        },
      });

      // The Realtime model does NOT continue speaking on its own after a
      // function_call_output — without an explicit response.create it goes silent
      // until the caller speaks again. Kick the next turn immediately, but ONLY for
      // tools where continuing makes sense: capture_lead_info and record_close_attempt.
      // escalate_to_human / set_call_outcome are transferring/ending the call, so we
      // must NOT auto-continue there. A response may occasionally still be in flight;
      // handleEvent tolerates the resulting "conversation_already_has_active_response".
      if (name === "capture_lead_info" || name === "record_close_attempt") {
        this.send({ type: "response.create" });
      }
    }
  }

  private async onCaptureLead(
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    // Validate every submitted value against its lead_fields definition BEFORE
    // persisting. Only the keys that pass are merged; invalid keys are dropped and
    // reported back to the model so it re-asks rather than storing junk.
    const { valid, invalid } = validateCapturedValues(this.leadFields, args);
    const savedKeys = Object.keys(valid);

    if (savedKeys.length > 0) {
      // Every valid captured answer (known OR custom key) is merged into
      // calls.captured_data, scoped to bot_id + call_id, regardless of whether we
      // know the caller number so dynamic/custom fields are always persisted.
      this.state.capturedData = { ...this.state.capturedData, ...valid };
      await mergeCapturedData(this.state.callId, valid);

      // ALSO keep the leads-table upsert in sync for the field_keys that map to
      // existing leads columns. Unknown/custom keys go to captured_data only (above).
      // The column mapping is shared with the SMS path (see ../leads/capture).
      const { updates, hasLeadColumns } = buildLeadColumnUpdates(valid);
      if (this.state.callerNumber && hasLeadColumns) {
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
    }

    if (Object.keys(invalid).length > 0) {
      return { status: "rejected", invalid, saved: savedKeys };
    }
    return { ok: true };
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

/**
 * Map the configured codec name to the GA audio-format object. The codec itself is
 * unchanged (g711_ulaw is still the telephony-native mu-law), but GA expresses the
 * format as an object with a MIME-style `type` instead of the old flat string:
 *   g711_ulaw → { type: "audio/pcmu" }, g711_alaw → { type: "audio/pcma" },
 *   pcm16     → { type: "audio/pcm", rate: 24000 }.
 */
function gaAudioFormat(codec: string): Record<string, unknown> {
  switch (codec) {
    case "g711_ulaw":
      return { type: "audio/pcmu" };
    case "g711_alaw":
      return { type: "audio/pcma" };
    case "pcm16":
      return { type: "audio/pcm", rate: 24000 };
    default:
      // Unknown/explicit value: pass through as a GA format object so an operator
      // can set a GA type directly via env without a code change.
      return { type: codec };
  }
}
