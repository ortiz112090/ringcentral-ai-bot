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
const mergeCapturedData = vi.fn(async () => {});
vi.mock("../db/queries", () => ({
  setRealtimeSessionId: (...a: any[]) => setRealtimeSessionId(...a),
  upsertLead: (...a: any[]) => upsertLead(...a),
  insertCallTranscriptTurn: (...a: any[]) => insertCallTranscriptTurn(...a),
  getLeadFields: (...a: any[]) => getLeadFields(...a),
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
  openai: { apiKey: "test-key" },
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
  type RealtimeCallbacks,
} from "./realtimeEngine";
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
  mergeCapturedData.mockResolvedValue(undefined);
  resolveEffectiveConfig.mockResolvedValue({
    openai: { apiKey: "test-key" },
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
    expect(session.audio.input.transcription).toEqual({ model: "whisper-1" });
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
      ["carrier", "date_of_birth", "first_name", "license_number", "quote_amount_monthly", "quote_amount_pif", "zip_code"].sort()
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
    const args = { start_timeline: "asap", address: "1 Main St" };
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

describe("barge-in gating from config", () => {
  it("suppresses onBargeIn when bargeInEnabled is false", async () => {
    resolveEffectiveConfig.mockResolvedValueOnce({
      openai: { apiKey: "test-key" },
      voice: { ...effectiveVoice, bargeInEnabled: false },
    } as any);
    const { ws, callbacks } = await startEngine();
    ws.emit("message", Buffer.from(JSON.stringify({ type: "input_audio_buffer.speech_started" })));
    expect(callbacks.bargeIns).toBe(0);
  });
});
