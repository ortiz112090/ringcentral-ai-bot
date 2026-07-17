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
vi.mock("../db/queries", () => ({
  setRealtimeSessionId: (...a: any[]) => setRealtimeSessionId(...a),
  upsertLead: (...a: any[]) => upsertLead(...a),
  insertCallTranscriptTurn: (...a: any[]) => insertCallTranscriptTurn(...a),
}));

// resolveEffectiveConfig must yield an API key so start() opens the socket; keep the
// rest of the real config module (model/voice/audio-format defaults) intact.
vi.mock("../config", async () => {
  const actual = await vi.importActual<typeof import("../config")>("../config");
  return {
    ...actual,
    resolveEffectiveConfig: vi.fn(async () => ({ openai: { apiKey: "test-key" } })),
  };
});

import { RealtimeEngine, type RealtimeCallbacks } from "./realtimeEngine";
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
    expect(session.audio.input.turn_detection).toEqual({ type: "server_vad" });
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
