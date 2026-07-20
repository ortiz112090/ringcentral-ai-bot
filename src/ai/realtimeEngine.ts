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
  mergeCapturedData,
  type LeadFieldRow,
} from "../db/queries";
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
  /**
   * Server VAD detected the caller started speaking over the bot (barge-in).
   * Transports that buffer outbound audio (e.g. Twilio Media Streams) use this to
   * flush their play buffer so the bot stops talking immediately. Optional.
   */
  onBargeIn?: () => void;
  /** The call reached a terminal outcome (non-escalation). Called at most once. */
  onOutcome: (outcome: CallOutcome) => void | Promise<void>;
}

/** Lead columns that also live on the `leads` table (kept in sync via upsertLead). */
const LEADS_TABLE_KEYS = [
  "first_name",
  "zip_code",
  "date_of_birth",
  "license_number",
  "quote_amount_pif",
  "quote_amount_monthly",
  "carrier",
] as const;

/**
 * Fallback capture_lead_info tool used when the dynamic lead_fields lookup fails or
 * returns no rows — identical to the previous hardcoded schema so the call flow is
 * never broken.
 */
const FALLBACK_CAPTURE_LEAD_TOOL = {
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
} as const;

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
 * Build the capture_lead_info tool's parameter schema from dashboard-configured
 * lead_fields. Field types map: text→string, number→number, date→string
 * (YYYY-MM-DD), choice→string enum. Each field's description is appended. Fields
 * are intentionally NOT marked JSON-schema-required — the model captures
 * opportunistically; `required` is only a dashboard/UI hint. Returns the fallback
 * hardcoded tool when no fields are provided.
 */
export function buildCaptureLeadTool(fields: LeadFieldRow[]): Record<string, unknown> {
  if (!fields || fields.length === 0) return { ...FALLBACK_CAPTURE_LEAD_TOOL };

  const properties: Record<string, Record<string, unknown>> = {};
  for (const field of fields) {
    if (!field.field_key) continue;
    const prop: Record<string, unknown> = {};
    switch (field.field_type) {
      case "number":
        prop.type = "number";
        break;
      case "date":
        prop.type = "string";
        prop.description = "YYYY-MM-DD";
        break;
      case "choice":
        prop.type = "string";
        if (Array.isArray(field.choices) && field.choices.length > 0) {
          prop.enum = field.choices;
        }
        break;
      case "text":
      default:
        prop.type = "string";
        break;
    }
    if (field.description && field.description.trim() !== "") {
      prop.description = prop.description
        ? `${prop.description} — ${field.description.trim()}`
        : field.description.trim();
    }
    properties[field.field_key] = prop;
  }

  return {
    type: "function",
    name: "capture_lead_info",
    description:
      "Record any lead detail you learned this turn. Call whenever you learn one.",
    parameters: { type: "object", properties },
  };
}

/** Outcome of validating a capture_lead_info payload against its lead_fields. */
export interface CapturedValidation {
  /** Keys that passed validation, with their (normalized) values — safe to persist. */
  valid: Record<string, unknown>;
  /** Keys that failed, mapped to a short human-readable reason. */
  invalid: Record<string, string>;
}

/** True when a field is a ZIP code by key or label ("ZIP" appears in the label). */
function isZipField(field: LeadFieldRow | undefined, key: string): boolean {
  if (key === "zip_code") return true;
  const label = typeof field?.label === "string" ? field.label.toLowerCase() : "";
  return label.includes("zip");
}

/**
 * Validate ONE captured value against its lead_fields definition. Returns either the
 * normalized value to store or a rejection reason. The ZIP rule takes precedence over
 * field_type (a ZIP field may be typed text or number). Keys with no matching field
 * definition are treated as free-form text.
 */
function validateOne(
  field: LeadFieldRow | undefined,
  key: string,
  value: unknown
): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (value === undefined || value === null) {
    return { ok: false, reason: "no value provided" };
  }

  if (isZipField(field, key)) {
    const digits = (String(value).match(/\d/g) ?? []).length;
    return digits === 5
      ? { ok: true, value }
      : { ok: false, reason: "must be a 5-digit ZIP code" };
  }

  const type = field?.field_type ?? "text";

  if (type === "number") {
    const cleaned = String(value).replace(/[$,]/g, "").trim();
    const n = Number(cleaned);
    return cleaned !== "" && Number.isFinite(n)
      ? { ok: true, value: n }
      : { ok: false, reason: "must be a number" };
  }

  if (type === "date") {
    return !Number.isNaN(Date.parse(String(value)))
      ? { ok: true, value }
      : { ok: false, reason: "must be a valid date" };
  }

  if (type === "choice" && Array.isArray(field?.choices) && field!.choices!.length > 0) {
    const match = field!.choices!.find(
      (c) => String(c).toLowerCase() === String(value).trim().toLowerCase()
    );
    return match !== undefined
      ? { ok: true, value: match }
      : { ok: false, reason: `must be one of: ${field!.choices!.join(", ")}` };
  }

  // text (and choice with no configured choices, and unknown keys): reject empty /
  // whitespace-only, and values containing no letters or digits at all.
  const str = String(value).trim();
  if (str === "" || !/[a-zA-Z0-9]/.test(str)) {
    return { ok: false, reason: "must contain letters or digits" };
  }
  return { ok: true, value };
}

/**
 * Server-side validation of a capture_lead_info payload against the loaded lead_fields
 * definitions. Pure + exported for unit testing. Splits the submitted values into the
 * keys that passed (`valid`, with normalized values) and the keys that failed
 * (`invalid`, key → reason) so callers can merge ONLY the valid keys and re-ask the
 * model for the rest. See the spec's per-type rules (number/date/choice/zip/text).
 */
export function validateCapturedValues(
  fields: LeadFieldRow[],
  values: Record<string, unknown>
): CapturedValidation {
  const byKey = new Map<string, LeadFieldRow>();
  for (const f of fields ?? []) {
    if (f.field_key) byKey.set(f.field_key, f);
  }

  const valid: Record<string, unknown> = {};
  const invalid: Record<string, string> = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    const result = validateOne(byKey.get(key), key, value);
    if (result.ok) valid[key] = result.value;
    else invalid[key] = result.reason;
  }
  return { valid, invalid };
}

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
        instructions: buildRealtimeInstructions(this.state.lead, lessons),
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
            voice: config.openai.realtimeVoice,
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
      if (this.state.callerNumber && LEADS_TABLE_KEYS.some((k) => valid[k] !== undefined)) {
        const carrier =
          typeof valid.carrier === "string" &&
          ["progressive", "dairyland", "other"].includes(valid.carrier)
            ? (valid.carrier as Carrier)
            : undefined;

        const updates = {
          first_name: str(valid.first_name),
          zip_code: str(valid.zip_code),
          date_of_birth: str(valid.date_of_birth),
          license_number: str(valid.license_number),
          quote_amount_pif: num(valid.quote_amount_pif),
          quote_amount_monthly: num(valid.quote_amount_monthly),
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

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && !Number.isNaN(v) ? v : undefined;
}
