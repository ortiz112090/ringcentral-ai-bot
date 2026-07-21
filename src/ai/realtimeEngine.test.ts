import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the frames the engine sends and let the test drive the socket lifecycle.
// A fake `ws` WebSocket stands in for the real Realtime connection so no network I/O
// happens and we can assert on the exact GA session/event JSON on the wire. Defined
// via vi.hoisted so the hoisted vi.mock factory below can reference it.
const { FakeWebSocket } = vi.hoisted(() => {
  class FakeWebSocket {
    static OPEN = 1;
    static instances: FakeWebSocket[] = [];
    readyState = FakeWebSocket.OPEN;
    sent: string[] = [];
    handlers: Record<string, (arg?: any) => void> = {};
    constructor(public url: string, public opts: any) {
      FakeWebSocket.instances.push(this);
    }
    on(event: string, cb: (arg?: any) => void) {
      this.handlers[event] = cb;
    }
    send(data: string) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
    }
    emit(event: string, arg?: any) {
      this.handlers[event]?.(arg);
    }
    sentJson(): any[] {
      return this.sent.map((s) => JSON.parse(s));
    }
  }
  return { FakeWebSocket };
});

vi.mock("ws", () => ({ default: FakeWebSocket }));

vi.mock("./retrieval", () => ({
  retrieveRelevantLessons: vi.fn(async () => []),
}));
vi.mock("./systemPrompt", () => ({
  buildRealtimeInstructions: vi.fn(() => "INSTRUCTIONS"),
}));

const setRealtimeSessionId = vi.fn(async () => {});
const upsertLead = vi.fn(async () => {});
const insertCallTranscriptTurn = vi.fn(async () => {});
const getLeadFields = vi.fn(async () => [] as any[]);
const getScriptStages = vi.fn(async () => [] as any[]);
const getScriptConstraints = vi.fn(async () => [] as any[]);
const mergeCapturedData = vi.fn(async () => {});
vi.mock("../db/queries", () => ({
  setRealtimeSessionId: (...a: any[]) => setRealtimeSessionId(...a),
  upsertLead: (...a: any[]) => upsertLead(...a),
  insertCallTranscriptTurn: (...a: any[]) => insertCallTranscriptTurn(...a),
  getLeadFields: (...a: any[]) => getLeadFields(...a),
  getScriptStages: (...a: any[]) => getScriptStages(...a),
  getScriptConstraints: (...a: any[]) => getScriptConstraints(...a),
  mergeCapturedData: (...a: any[]) => mergeCapturedData(...a),
}));

// resolveEffectiveConfig must yield an API key so start() opens the socket, plus the
// voice VAD settings the engine builds turn_detection from; keep the rest of the real
// config module (model/voice/audio-format defaults) intact.
const effectiveVoice = {
  vadThreshold: 0.7,
  vadSilenceMs: 800,
  vadPrefixPaddingMs: 300,
  bargeInEnabled: true,
};
const resolveEffectiveConfig = vi.fn(async () => ({
  openai: { apiKey: "test-key", transcribeModel: "gpt-4o-transcribe" },
  realtimeVoice: "alloy",
  realtimeSpeed: 1.0,
  voice: { ...effectiveVoice },
}));
vi.mock("../config", async () => {
  const actual = await vi.importActual<typeof import("../config")>("../config");
  return {
    ...actual,
    resolveEffectiveConfig: (...a: any[]) => resolveEffectiveConfig(...a),
  };
});

import {
  RealtimeEngine,
  buildCaptureLeadTool,
  buildTurnDetection,
  buildTranscriptionConfig,
  validateCapturedValues,
  resolveRealtimeVoice,
  SUPPORTED_REALTIME_VOICES,
  STATIC_TRANSCRIPTION_VOCAB,
  type RealtimeCallbacks,
} from "./realtimeEngine";
import type { LeadFieldRow } from "../db/queries";
import { buildRealtimeInstructions } from "./systemPrompt";
import { config } from "../config";
import type { CallState } from "../state/conversationStore";

function makeState(): CallState {
  return {
    callId: "call-1",
    callerNumber: "+15557654321",
    lead: null,
    history: [],
    transcript: [],
    stage: "opener",
    closeAttempts: 0,
    startedAt: new Date().toISOString(),
    capturedData: {},
  } as CallState;
}

function makeCallbacks(): RealtimeCallbacks & {
  audio: string[];
  bargeIns: number;
  escalations: string[];
} {
  const audio: string[] = [];
  const escalations: string[] = [];
  let bargeIns = 0;
  return {
    audio,
    escalations,
    get bargeIns() {
      return bargeIns;
    },
    onBotAudio: (a: string) => audio.push(a),
    onEscalate: async (r: string) => {
      escalations.push(r);
    },
    onBargeIn: () => {
      bargeIns += 1;
    },
    onOutcome: async () => {},
  };
}

async function startEngine() {
  const state = makeState();
  const callbacks = makeCallbacks();
  const engine = new RealtimeEngine(state, callbacks);
  await engine.start();
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  ws.emit("open");
  return { engine, callbacks, ws, state };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.clearAllMocks();
  // Restore default mock behavior cleared by clearAllMocks.
  getLeadFields.mockResolvedValue([]);
  getScriptStages.mockResolvedValue([]);
  getScriptConstraints.mockResolvedValue([]);
  mergeCapturedData.mockResolvedValue(undefined);
  resolveEffectiveConfig.mockResolvedValue({
    openai: { apiKey: "test-key", transcribeModel: "gpt-4o-transcribe" },
    realtimeVoice: "alloy",
    realtimeSpeed: 1.0,
    voice: { ...effectiveVoice },
  } as any);
});

describe("RealtimeEngine GA wire protocol", () => {
  it("connects to /v1/realtime with the GA model and no OpenAI-Beta header", async () => {
    const { ws } = await startEngine();
    expect(ws.url).toContain("wss://api.openai.com/v1/realtime");
    expect(ws.url).toContain(`model=${encodeURIComponent(config.openai.realtimeModel)}`);
    expect(config.openai.realtimeModel).toBe("gpt-realtime-2.1");
    expect(ws.opts.headers.Authorization).toBe("Bearer test-key");
    expect(ws.opts.headers).not.toHaveProperty("OpenAI-Beta");
  });

  it("sends a GA session.update: session.type + nested audio with object format", async () => {
    const { ws } = await startEngine();
    const update = ws.sentJson().find((m) => m.type === "session.update");
    expect(update).toBeDefined();
    const session = update.session;

    // GA requires session.type.
    expect(session.type).toBe("realtime");

    // No leftover beta-flat audio fields.
    expect(session).not.toHaveProperty("input_audio_format");
    expect(session).not.toHaveProperty("output_audio_format");
    expect(session).not.toHaveProperty("modalities");
    expect(session).not.toHaveProperty("voice");

    // Audio nested under session.audio.{input,output}; format is an object; the
    // g711_ulaw codec maps to the GA mu-law type audio/pcmu (value unchanged codec).
    expect(session.audio.input.format).toEqual({ type: "audio/pcmu" });
    expect(session.audio.output.format).toEqual({ type: "audio/pcmu" });
    expect(session.audio.output.voice).toBe(config.openai.realtimeVoice);
    // turn_detection is now built from the effective voice config (defaults here).
    expect(session.audio.input.turn_detection).toEqual({
      type: "server_vad",
      threshold: 0.7,
      silence_duration_ms: 800,
      prefix_padding_ms: 300,
    });
    // GA input transcription now uses gpt-4o-transcribe + English + a vocab prompt.
    expect(session.audio.input.transcription.model).toBe("gpt-4o-transcribe");
    expect(session.audio.input.transcription.language).toBe("en");
    expect(typeof session.audio.input.transcription.prompt).toBe("string");
    expect(session.audio.input.transcription.prompt).toContain("SR22");
    // OpenAI server-side input noise reduction is nested under audio.input (GA shape).
    expect(session.audio.input.noise_reduction).toEqual({ type: "near_field" });
  });

  it("forwards GA output audio deltas to onBotAudio", async () => {
    const { ws, callbacks } = await startEngine();
    ws.emit("message", Buffer.from(JSON.stringify({ type: "response.output_audio.delta", delta: "AAA" })));
    // The retired beta name must NOT be handled anymore.
    ws.emit("message", Buffer.from(JSON.stringify({ type: "response.audio.delta", delta: "OLD" })));
    expect(callbacks.audio).toEqual(["AAA"]);
  });

  it("still signals barge-in on the (unchanged) speech_started event", async () => {
    const { ws, callbacks } = await startEngine();
    ws.emit("message", Buffer.from(JSON.stringify({ type: "input_audio_buffer.speech_started" })));
    expect(callbacks.bargeIns).toBe(1);
  });

  it("records the assistant transcript on the GA output_audio_transcript.done event", async () => {
    const { ws, state } = await startEngine();
    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "response.output_audio_transcript.done", transcript: "hello there" }))
    );
    expect(state.transcript.length).toBeGreaterThan(0);
  });

  it("persists the realtime session id on session.created", async () => {
    const { ws } = await startEngine();
    ws.emit("message", Buffer.from(JSON.stringify({ type: "session.created", session: { id: "sess_123" } })));
    expect(setRealtimeSessionId).toHaveBeenCalledWith("call-1", "sess_123");
  });
});

describe("buildTurnDetection", () => {
  it("maps the effective voice config to GA server_vad fields", () => {
    expect(
      buildTurnDetection({
        vadThreshold: 0.82,
        vadSilenceMs: 1200,
        vadPrefixPaddingMs: 250,
        bargeInEnabled: true,
      })
    ).toEqual({
      type: "server_vad",
      threshold: 0.82,
      silence_duration_ms: 1200,
      prefix_padding_ms: 250,
    });
  });
});

describe("buildTranscriptionConfig", () => {
  const field = (label: string | null): any => ({
    field_key: "k",
    label,
    description: null,
    field_type: "text",
    choices: null,
    required: false,
    sort_order: 1,
  });

  it("uses the default model + the static natural-language vocab when there are no fields", () => {
    const cfg = buildTranscriptionConfig("gpt-4o-transcribe", []);
    expect(cfg).toEqual({
      model: "gpt-4o-transcribe",
      language: "en",
      prompt: STATIC_TRANSCRIPTION_VOCAB,
    });
  });

  it("uses a natural-language sentence, not a keyword/term list", () => {
    const cfg = buildTranscriptionConfig("gpt-4o-transcribe", []);
    // Anti-echo: a fluent sentence, not "Expect terms like:" / colon-delimited dump.
    expect(cfg.prompt).toContain("SR22");
    expect(cfg.prompt).not.toContain("Expect terms like");
    expect(cfg.prompt).not.toMatch(/:/); // no "label:" list separators
    expect(cfg.prompt.trim()).toMatch(/\.$/); // reads as a sentence
  });

  it("no longer appends the lead-field label list to the prompt", () => {
    const cfg = buildTranscriptionConfig("gpt-4o-transcribe", [
      field("Start timeline"),
      field("Vehicle year"),
    ]);
    expect(cfg.prompt).toBe(STATIC_TRANSCRIPTION_VOCAB);
    expect(cfg.prompt).not.toContain("Lead fields:");
    expect(cfg.prompt).not.toContain("Start timeline");
    expect(cfg.prompt).not.toContain("Vehicle year");
  });

  it("keeps the prompt short (<= 300 chars)", () => {
    const many = Array.from({ length: 100 }, (_, i) => field(`Field label number ${i}`));
    const cfg = buildTranscriptionConfig("gpt-4o-transcribe", many);
    expect(cfg.prompt.length).toBeLessThanOrEqual(300);
    expect(STATIC_TRANSCRIPTION_VOCAB.length).toBeLessThanOrEqual(300);
  });

  it("passes the model name through unchanged (env override lands here)", () => {
    const cfg = buildTranscriptionConfig("custom-transcribe-model", []);
    expect(cfg.model).toBe("custom-transcribe-model");
  });
});

describe("buildCaptureLeadTool dynamic schema", () => {
  it("builds properties by field type and appends descriptions", () => {
    const tool = buildCaptureLeadTool([
      { field_key: "first_name", label: "First name", description: "Legal first name", field_type: "text", choices: null, required: true, sort_order: 1 },
      { field_key: "quote_amount_pif", label: "PIF", description: null, field_type: "number", choices: null, required: false, sort_order: 2 },
      { field_key: "date_of_birth", label: "DOB", description: "on their license", field_type: "date", choices: null, required: false, sort_order: 3 },
      { field_key: "carrier", label: "Carrier", description: null, field_type: "choice", choices: ["progressive", "dairyland", "other"], required: false, sort_order: 4 },
    ]);

    expect(tool.name).toBe("capture_lead_info");
    const props = (tool.parameters as any).properties;
    expect(props.first_name).toEqual({ type: "string", description: "Legal first name" });
    expect(props.quote_amount_pif).toEqual({ type: "number" });
    // date carries its format hint and appends the field description.
    expect(props.date_of_birth).toEqual({ type: "string", description: "YYYY-MM-DD — on their license" });
    expect(props.carrier).toEqual({ type: "string", enum: ["progressive", "dairyland", "other"] });
    // Nothing is JSON-schema-required even when a field's `required` hint is true.
    expect((tool.parameters as any).required).toBeUndefined();
  });

  it("falls back to the hardcoded schema when there are no fields", () => {
    const tool = buildCaptureLeadTool([]);
    const props = (tool.parameters as any).properties;
    expect(Object.keys(props).sort()).toEqual(
      ["carrier", "date_of_birth", "first_name", "license_number", "license_state", "quote_amount_monthly", "quote_amount_pif", "zip_code"].sort()
    );
    expect(props.carrier.enum).toEqual(["progressive", "dairyland", "other"]);
  });
});

describe("dynamic capture tool wiring + captured_data merge", () => {
  it("sends the dynamically-built capture_lead_info tool in session.update", async () => {
    getLeadFields.mockResolvedValueOnce([
      { field_key: "zip_code", label: "ZIP", description: null, field_type: "text", choices: null, required: true, sort_order: 1 },
      { field_key: "start_timeline", label: "Start", description: "When coverage should begin", field_type: "text", choices: null, required: false, sort_order: 2 },
    ]);
    const { ws } = await startEngine();
    const update = ws.sentJson().find((m: any) => m.type === "session.update");
    const captureTool = update.session.tools.find((t: any) => t.name === "capture_lead_info");
    expect(Object.keys(captureTool.parameters.properties)).toEqual(["zip_code", "start_timeline"]);
    // The three static tools are still present and hardcoded.
    const names = update.session.tools.map((t: any) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["capture_lead_info", "record_close_attempt", "escalate_to_human", "set_call_outcome"])
    );
  });

  it("falls back to the hardcoded capture tool when lead_fields load fails", async () => {
    getLeadFields.mockRejectedValueOnce(new Error("db down"));
    const { ws } = await startEngine();
    const update = ws.sentJson().find((m: any) => m.type === "session.update");
    // start() must not throw and the socket still opens with the fallback schema.
    const captureTool = update.session.tools.find((t: any) => t.name === "capture_lead_info");
    expect(captureTool.parameters.properties.first_name).toEqual({ type: "string" });
  });

  it("merges captured args into captured_data AND upserts known lead columns", async () => {
    const { ws, state } = await startEngine();
    const args = { first_name: "Sam", zip_code: "90210", start_timeline: "next week" };
    ws.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          name: "capture_lead_info",
          arguments: JSON.stringify(args),
          call_id: "fc_1",
        })
      )
    );
    // Let the async tool handler run.
    await new Promise((r) => setTimeout(r, 0));

    expect(mergeCapturedData).toHaveBeenCalledWith("call-1", args);
    expect(state.capturedData).toMatchObject(args);
    // Known columns still go to the leads table; the custom key is ignored there.
    expect(upsertLead).toHaveBeenCalledTimes(1);
    const leadArg = upsertLead.mock.calls[0][0] as any;
    expect(leadArg.first_name).toBe("Sam");
    expect(leadArg.zip_code).toBe("90210");
    expect(leadArg).not.toHaveProperty("start_timeline");
  });

  it("merges custom-only captures without a leads-table upsert", async () => {
    const { ws, state } = await startEngine();
    const args = { start_timeline: "asap", address: "1 Main St, Springfield, 90210" };
    ws.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          name: "capture_lead_info",
          arguments: JSON.stringify(args),
          call_id: "fc_2",
        })
      )
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(mergeCapturedData).toHaveBeenCalledWith("call-1", args);
    expect(state.capturedData).toMatchObject(args);
    // No known lead columns present → no leads upsert.
    expect(upsertLead).not.toHaveBeenCalled();
  });
});

describe("validateCapturedValues", () => {
  const f = (over: Partial<LeadFieldRow>): LeadFieldRow => ({
    field_key: "k",
    label: null,
    description: null,
    field_type: "text",
    choices: null,
    required: false,
    sort_order: 1,
    ...over,
  });

  it("number: strips $/commas and parses to a finite number (valid)", () => {
    const fields = [f({ field_key: "quote_amount_pif", field_type: "number" })];
    const res = validateCapturedValues(fields, { quote_amount_pif: "$1,200" });
    expect(res.invalid).toEqual({});
    expect(res.valid.quote_amount_pif).toBe(1200);
  });

  it("number: rejects non-numeric text", () => {
    const fields = [f({ field_key: "quote_amount_pif", field_type: "number" })];
    const res = validateCapturedValues(fields, { quote_amount_pif: "cheap" });
    expect(res.valid).toEqual({});
    expect(res.invalid.quote_amount_pif).toMatch(/number/i);
  });

  it("date: accepts natural formats and stores as given", () => {
    const fields = [f({ field_key: "date_of_birth", field_type: "date" })];
    const res = validateCapturedValues(fields, { date_of_birth: "March 5, 1990" });
    expect(res.invalid).toEqual({});
    expect(res.valid.date_of_birth).toBe("March 5, 1990");
  });

  it("date: rejects unparseable junk", () => {
    const fields = [f({ field_key: "date_of_birth", field_type: "date" })];
    const res = validateCapturedValues(fields, { date_of_birth: "blah" });
    expect(res.valid).toEqual({});
    expect(res.invalid.date_of_birth).toMatch(/date/i);
  });

  it("choice: case-insensitive match, stores canonical choice", () => {
    const fields = [
      f({ field_key: "carrier", field_type: "choice", choices: ["progressive", "dairyland", "other"] }),
    ];
    const res = validateCapturedValues(fields, { carrier: "Progressive" });
    expect(res.invalid).toEqual({});
    expect(res.valid.carrier).toBe("progressive");
  });

  it("choice: rejects a value not in the choices array", () => {
    const fields = [
      f({ field_key: "carrier", field_type: "choice", choices: ["progressive", "dairyland"] }),
    ];
    const res = validateCapturedValues(fields, { carrier: "geico" });
    expect(res.valid).toEqual({});
    expect(res.invalid.carrier).toMatch(/one of/i);
  });

  it("zip by field_key: requires exactly 5 digits", () => {
    const fields = [f({ field_key: "zip_code", field_type: "text" })];
    expect(validateCapturedValues(fields, { zip_code: "90210" }).valid.zip_code).toBe("90210");
    expect(validateCapturedValues(fields, { zip_code: "9021" }).invalid.zip_code).toMatch(/5-digit/);
    expect(validateCapturedValues(fields, { zip_code: "902100" }).invalid.zip_code).toMatch(/5-digit/);
  });

  it("zip by label ('ZIP' in label) takes precedence over field_type", () => {
    const fields = [f({ field_key: "postal", label: "Home ZIP", field_type: "number" })];
    expect(validateCapturedValues(fields, { postal: "abcde" }).invalid.postal).toMatch(/5-digit/);
    expect(validateCapturedValues(fields, { postal: "12345" }).valid.postal).toBe("12345");
  });

  it("text: rejects empty/whitespace and values with no letters or digits", () => {
    const fields = [f({ field_key: "first_name", field_type: "text" })];
    expect(validateCapturedValues(fields, { first_name: "Sam" }).valid.first_name).toBe("Sam");
    expect(validateCapturedValues(fields, { first_name: "   " }).invalid.first_name).toBeDefined();
    expect(validateCapturedValues(fields, { first_name: "!!!" }).invalid.first_name).toBeDefined();
  });

  it("keeps valid keys and drops only the invalid ones (mixed submission)", () => {
    const fields = [
      f({ field_key: "first_name", field_type: "text" }),
      f({ field_key: "zip_code", field_type: "text" }),
    ];
    const res = validateCapturedValues(fields, { first_name: "Sam", zip_code: "9" });
    expect(res.valid).toEqual({ first_name: "Sam" });
    expect(Object.keys(res.invalid)).toEqual(["zip_code"]);
  });

  it("treats keys with no field definition as free-form text", () => {
    const res = validateCapturedValues([], { note: "call back later", junk: "   " });
    expect(res.valid).toEqual({ note: "call back later" });
    expect(res.invalid.junk).toBeDefined();
  });

  describe("address field completion", () => {
    const fields = [f({ field_key: "address", field_type: "text" })];

    it("passes a full address with a street number and 5-digit zip", () => {
      const res = validateCapturedValues(fields, {
        address: "12 Gold Street, Springfield, 90210",
      });
      expect(res.invalid).toEqual({});
      expect(res.valid.address).toBe("12 Gold Street, Springfield, 90210");
    });

    it("rejects a partial address that is missing the zip, naming zip", () => {
      const res = validateCapturedValues(fields, { address: "12 Gold Street, Springfield" });
      expect(res.valid).toEqual({});
      expect(res.invalid.address).toMatch(/zip/i);
    });

    it("rejects a fragment with no street number, naming the street number", () => {
      const res = validateCapturedValues(fields, { address: "Gold Street" });
      expect(res.invalid.address).toMatch(/street number/i);
    });

    it("rejects a number+zip with no city/street name, naming the city", () => {
      const res = validateCapturedValues(fields, { address: "12 90210" });
      expect(res.invalid.address).toMatch(/city/i);
    });
  });

  describe("date_of_birth field completion", () => {
    const fields = [f({ field_key: "date_of_birth", field_type: "date" })];

    it("passes a full valid DOB", () => {
      const res = validateCapturedValues(fields, { date_of_birth: "March 5, 1990" });
      expect(res.invalid).toEqual({});
      expect(res.valid.date_of_birth).toBe("March 5, 1990");
    });

    it("rejects a partial DOB (month + year only), naming the missing day", () => {
      const res = validateCapturedValues(fields, { date_of_birth: "March 1990" });
      expect(res.valid).toEqual({});
      expect(res.invalid.date_of_birth).toMatch(/day/i);
    });

    it("rejects a numeric fragment with fewer than three parts", () => {
      const res = validateCapturedValues(fields, { date_of_birth: "3/1990" });
      expect(res.invalid.date_of_birth).toMatch(/incomplete|month|day|year/i);
    });
  });

  describe("license_number field completion", () => {
    const fields = [f({ field_key: "license_number", field_type: "text" })];

    it("strips dashes/spaces before saving and passes", () => {
      const res = validateCapturedValues(fields, { license_number: "D123-4567 89" });
      expect(res.invalid).toEqual({});
      expect(res.valid.license_number).toBe("D123456789");
    });

    it("rejects an obviously truncated single-character number", () => {
      const res = validateCapturedValues(fields, { license_number: "D" });
      expect(res.valid).toEqual({});
      expect(res.invalid.license_number).toMatch(/incomplete/i);
    });
  });

  describe("license_state field completion", () => {
    const fields = [f({ field_key: "license_state", field_type: "text" })];

    it("normalizes a full state name to its 2-letter code", () => {
      const res = validateCapturedValues(fields, { license_state: "california" });
      expect(res.invalid).toEqual({});
      expect(res.valid.license_state).toBe("CA");
    });

    it("normalizes a lower-case abbreviation to upper-case", () => {
      const res = validateCapturedValues(fields, { license_state: "ca" });
      expect(res.valid.license_state).toBe("CA");
    });

    it("rejects a string that is not a recognizable US state", () => {
      const res = validateCapturedValues(fields, { license_state: "Freedonia" });
      expect(res.valid).toEqual({});
      expect(res.invalid.license_state).toMatch(/state/i);
    });
  });
});

describe("capture_lead_info server-side validation wiring", () => {
  function fireCapture(ws: any, args: Record<string, unknown>, callId = "fc_v") {
    ws.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          name: "capture_lead_info",
          arguments: JSON.stringify(args),
          call_id: callId,
        })
      )
    );
  }

  function outputFor(ws: any, callId: string): any {
    const frame = ws
      .sentJson()
      .find(
        (m: any) => m.type === "conversation.item.create" && m.item?.call_id === callId
      );
    return frame ? JSON.parse(frame.item.output) : undefined;
  }

  it("returns a rejection output and merges ONLY the valid keys", async () => {
    getLeadFields.mockResolvedValueOnce([
      { field_key: "first_name", label: "First name", description: null, field_type: "text", choices: null, required: false, sort_order: 1 },
      { field_key: "zip_code", label: "ZIP", description: null, field_type: "text", choices: null, required: false, sort_order: 2 },
    ]);
    const { ws, state } = await startEngine();
    fireCapture(ws, { first_name: "Sam", zip_code: "9" }, "fc_bad");
    await new Promise((r) => setTimeout(r, 0));

    // Only the valid key is persisted.
    expect(mergeCapturedData).toHaveBeenCalledWith("call-1", { first_name: "Sam" });
    expect(state.capturedData).toEqual({ first_name: "Sam" });
    expect(state.capturedData).not.toHaveProperty("zip_code");

    // The model gets a rejection payload it can re-ask on.
    const out = outputFor(ws, "fc_bad");
    expect(out.status).toBe("rejected");
    expect(out.invalid.zip_code).toMatch(/5-digit/);
    expect(out.saved).toEqual(["first_name"]);
  });

  it("returns the success output when all values are valid", async () => {
    getLeadFields.mockResolvedValueOnce([
      { field_key: "first_name", label: "First name", description: null, field_type: "text", choices: null, required: false, sort_order: 1 },
    ]);
    const { ws } = await startEngine();
    fireCapture(ws, { first_name: "Sam" }, "fc_ok");
    await new Promise((r) => setTimeout(r, 0));

    expect(mergeCapturedData).toHaveBeenCalledWith("call-1", { first_name: "Sam" });
    expect(outputFor(ws, "fc_ok")).toEqual({ ok: true });
  });

  it("does not persist anything when every value is invalid", async () => {
    getLeadFields.mockResolvedValueOnce([
      { field_key: "zip_code", label: "ZIP", description: null, field_type: "text", choices: null, required: false, sort_order: 1 },
    ]);
    const { ws, state } = await startEngine();
    fireCapture(ws, { zip_code: "nope" }, "fc_none");
    await new Promise((r) => setTimeout(r, 0));

    expect(mergeCapturedData).not.toHaveBeenCalled();
    expect(state.capturedData).toEqual({});
    const out = outputFor(ws, "fc_none");
    expect(out.status).toBe("rejected");
    expect(out.saved).toEqual([]);
  });
});

describe("auto-continue after tool calls (response.create)", () => {
  function fireTool(ws: any, name: string, args: Record<string, unknown>, callId: string) {
    ws.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          name,
          arguments: JSON.stringify(args),
          call_id: callId,
        })
      )
    );
  }

  // Only response.create frames sent AFTER the initial opener (index 0) count as
  // continuations; drop the opener so we assert on the tool-driven one.
  function responseCreatesAfterOpener(ws: any): any[] {
    const all = ws.sentJson().filter((m: any) => m.type === "response.create");
    return all.slice(1);
  }

  it("sends response.create after a capture_lead_info function_call_output", async () => {
    const { ws } = await startEngine();
    fireTool(ws, "capture_lead_info", { first_name: "Sam" }, "fc_cont");
    await new Promise((r) => setTimeout(r, 0));

    const frames = ws.sentJson();
    const ackIdx = frames.findIndex(
      (m: any) => m.type === "conversation.item.create" && m.item?.call_id === "fc_cont"
    );
    const contIdx = frames.findIndex(
      (m: any, i: number) => i > ackIdx && m.type === "response.create"
    );
    expect(ackIdx).toBeGreaterThanOrEqual(0);
    // A response.create follows the function_call_output for capture_lead_info.
    expect(contIdx).toBeGreaterThan(ackIdx);
  });

  it("sends response.create after a record_close_attempt function_call_output", async () => {
    const { ws } = await startEngine();
    fireTool(ws, "record_close_attempt", { attempt_number: 1 }, "fc_close");
    await new Promise((r) => setTimeout(r, 0));
    expect(responseCreatesAfterOpener(ws).length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT send response.create after escalate_to_human", async () => {
    const { ws } = await startEngine();
    fireTool(ws, "escalate_to_human", { reason: "wants a human" }, "fc_esc");
    await new Promise((r) => setTimeout(r, 0));
    // Only the opener response.create should exist; no continuation for escalation.
    expect(responseCreatesAfterOpener(ws)).toEqual([]);
  });

  it("does NOT send response.create after set_call_outcome", async () => {
    const { ws } = await startEngine();
    fireTool(ws, "set_call_outcome", { outcome: "closed_pif" }, "fc_out");
    await new Promise((r) => setTimeout(r, 0));
    expect(responseCreatesAfterOpener(ws)).toEqual([]);
  });

  it("ignores a conversation_already_has_active_response error without escalating", async () => {
    const { ws, callbacks } = await startEngine();
    ws.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "error",
          error: { code: "conversation_already_has_active_response" },
        })
      )
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(callbacks.escalations).toEqual([]);
  });

  it("still escalates on other error events", async () => {
    const { ws, callbacks } = await startEngine();
    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "error", error: { code: "server_error" } }))
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(callbacks.escalations).toEqual(["model_error"]);
  });
});

describe("barge-in gating from config", () => {
  it("suppresses onBargeIn when bargeInEnabled is false", async () => {
    resolveEffectiveConfig.mockResolvedValueOnce({
      openai: { apiKey: "test-key" },
      realtimeVoice: "alloy",
      voice: { ...effectiveVoice, bargeInEnabled: false },
    } as any);
    const { ws, callbacks } = await startEngine();
    ws.emit("message", Buffer.from(JSON.stringify({ type: "input_audio_buffer.speech_started" })));
    expect(callbacks.bargeIns).toBe(0);
  });
});

describe("resolveRealtimeVoice GA validation", () => {
  it("accepts every supported GA voice (case-insensitive)", () => {
    for (const v of SUPPORTED_REALTIME_VOICES) {
      expect(resolveRealtimeVoice(v)).toBe(v);
      expect(resolveRealtimeVoice(v.toUpperCase())).toBe(v);
    }
  });

  it("falls back to cedar for an unsupported voice", () => {
    expect(resolveRealtimeVoice("nova")).toBe("cedar");
  });

  it("falls back to cedar for empty/undefined", () => {
    expect(resolveRealtimeVoice("")).toBe("cedar");
    expect(resolveRealtimeVoice("   ")).toBe("cedar");
    expect(resolveRealtimeVoice(undefined)).toBe("cedar");
    expect(resolveRealtimeVoice(null)).toBe("cedar");
  });
});

describe("session.update uses the per-call effective voice", () => {
  it("sends the resolved bot_config voice (e.g. 'sage'), not the static env config", async () => {
    resolveEffectiveConfig.mockResolvedValueOnce({
      openai: { apiKey: "test-key", transcribeModel: "gpt-4o-transcribe" },
      realtimeVoice: "sage",
      voice: { ...effectiveVoice },
    } as any);
    const { ws } = await startEngine();
    const update = ws.sentJson().find((m: any) => m.type === "session.update");
    expect(update.session.audio.output.voice).toBe("sage");
  });

  it("falls back to cedar when the per-call voice is unsupported (e.g. 'nova')", async () => {
    resolveEffectiveConfig.mockResolvedValueOnce({
      openai: { apiKey: "test-key", transcribeModel: "gpt-4o-transcribe" },
      realtimeVoice: "nova",
      realtimeSpeed: 1.0,
      voice: { ...effectiveVoice },
    } as any);
    const { ws } = await startEngine();
    const update = ws.sentJson().find((m: any) => m.type === "session.update");
    expect(update.session.audio.output.voice).toBe("cedar");
  });
});

describe("session.update sends the per-call output speed", () => {
  it("emits session.audio.output.speed from the effective config (e.g. 1.15)", async () => {
    resolveEffectiveConfig.mockResolvedValueOnce({
      openai: { apiKey: "test-key", transcribeModel: "gpt-4o-transcribe" },
      realtimeVoice: "alloy",
      realtimeSpeed: 1.15,
      voice: { ...effectiveVoice },
    } as any);
    const { ws } = await startEngine();
    const update = ws.sentJson().find((m: any) => m.type === "session.update");
    expect(update.session.audio.output.speed).toBe(1.15);
    // Sent alongside voice, not replacing it.
    expect(update.session.audio.output.voice).toBe("alloy");
  });

  it("defaults output.speed to 1.0 from the effective config", async () => {
    const { ws } = await startEngine();
    const update = ws.sentJson().find((m: any) => m.type === "session.update");
    expect(update.session.audio.output.speed).toBe(1.0);
  });
});

describe("session setup loads and passes the DB script", () => {
  it("passes active stages + constraints into buildRealtimeInstructions", async () => {
    const stages = [
      { stage_key: "opener", stage_order: 1, stage_type: "opener", title: "Opener", script_text: "Hi" },
    ];
    const constraints = [{ rule_text: "No refunds", severity: "critical" }];
    getScriptStages.mockResolvedValueOnce(stages as any);
    getScriptConstraints.mockResolvedValueOnce(constraints as any);

    const { state } = await startEngine();

    const buildMock = vi.mocked(buildRealtimeInstructions);
    expect(buildMock).toHaveBeenCalledWith(state.lead, [], stages, constraints);
  });
});
