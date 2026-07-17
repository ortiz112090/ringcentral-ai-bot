import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the bridge + call lifecycle so the session's effects are observable and no
// real Realtime/Supabase/Twilio I/O occurs.
const startCallBridge = vi.fn(async () => {});
const attachMediaSink = vi.fn();
const attachBargeInHandler = vi.fn();
const pushCallerAudio = vi.fn();
const endCallBridge = vi.fn();
const onCallEnded = vi.fn(async () => {});
const escalateTwilioCall = vi.fn(async () => {});

vi.mock("../ringcentral/audioBridge", () => ({
  startCallBridge: (...a: any[]) => startCallBridge(...a),
  attachMediaSink: (...a: any[]) => attachMediaSink(...a),
  attachBargeInHandler: (...a: any[]) => attachBargeInHandler(...a),
  pushCallerAudio: (...a: any[]) => pushCallerAudio(...a),
  endCallBridge: (...a: any[]) => endCallBridge(...a),
}));
vi.mock("../callHandler", () => ({
  onCallEnded: (...a: any[]) => onCallEnded(...a),
}));
vi.mock("./escalation", () => ({
  escalateTwilioCall: (...a: any[]) => escalateTwilioCall(...a),
}));

const AUTH_TOKEN = "test-auth-token";
vi.mock("./client", () => ({
  getTwilioAuthToken: vi.fn(async () => AUTH_TOKEN),
}));

import { createMediaSession, type TwilioSocket } from "./mediaStream";
import { createStreamToken } from "./streamToken";

function fakeSocket(): TwilioSocket & { sent: string[]; closed: number } {
  const s: any = { sent: [] as string[], closed: 0 };
  s.send = (d: string) => s.sent.push(d);
  s.close = () => {
    s.closed += 1;
  };
  return s;
}

function startFrame(opts: { callSid?: string; token?: string } = {}): string {
  const callSid = opts.callSid ?? "CA456";
  const token = opts.token ?? createStreamToken(callSid, AUTH_TOKEN);
  return JSON.stringify({
    event: "start",
    streamSid: "MZ123",
    start: {
      streamSid: "MZ123",
      callSid,
      customParameters: { from: "+15557654321", to: "+15550000001", token },
    },
  });
}

const startMsg = startFrame();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Twilio media stream lifecycle", () => {
  it("start → begins the bridge and wires the outbound + barge-in sinks", async () => {
    const socket = fakeSocket();
    const session = createMediaSession(socket);
    await session.onMessage(startMsg);

    expect(startCallBridge).toHaveBeenCalledTimes(1);
    const [callSid, streamSid, callerNumber, options] = startCallBridge.mock.calls[0];
    expect(callSid).toBe("CA456");
    expect(streamSid).toBe("MZ123");
    expect(callerNumber).toBe("+15557654321");
    expect(typeof options.onEscalate).toBe("function");

    expect(attachMediaSink).toHaveBeenCalledWith("CA456", expect.any(Function));
    expect(attachBargeInHandler).toHaveBeenCalledWith("CA456", expect.any(Function));

    // The registered media sink emits a Twilio "media" frame with the streamSid.
    const sink = attachMediaSink.mock.calls[0][1] as (p: string) => void;
    sink("BASE64AUDIO");
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0])).toEqual({
      event: "media",
      streamSid: "MZ123",
      media: { payload: "BASE64AUDIO" },
    });

    // The barge-in handler emits a "clear" frame.
    const onClear = attachBargeInHandler.mock.calls[0][1] as () => void;
    onClear();
    expect(JSON.parse(socket.sent[1])).toEqual({ event: "clear", streamSid: "MZ123" });
  });

  it("media → forwards the inbound payload to the model", async () => {
    const session = createMediaSession(fakeSocket());
    await session.onMessage(startMsg);
    await session.onMessage(
      JSON.stringify({ event: "media", media: { payload: "INBOUND1" } })
    );
    expect(pushCallerAudio).toHaveBeenCalledWith("CA456", "INBOUND1");
  });

  it("stop → tears down the bridge and finalizes the call", async () => {
    const session = createMediaSession(fakeSocket());
    await session.onMessage(startMsg);
    await session.onMessage(JSON.stringify({ event: "stop" }));
    expect(endCallBridge).toHaveBeenCalledWith("CA456");
    expect(onCallEnded).toHaveBeenCalledWith("CA456");
  });

  it("teardown is idempotent (stop then socket close does not double-finalize)", async () => {
    const session = createMediaSession(fakeSocket());
    await session.onMessage(startMsg);
    await session.onMessage(JSON.stringify({ event: "stop" }));
    await session.teardown();
    expect(endCallBridge).toHaveBeenCalledTimes(1);
    expect(onCallEnded).toHaveBeenCalledTimes(1);
  });

  it("media before start is ignored (no callSid yet)", async () => {
    const session = createMediaSession(fakeSocket());
    await session.onMessage(
      JSON.stringify({ event: "media", media: { payload: "EARLY" } })
    );
    expect(pushCallerAudio).not.toHaveBeenCalled();
  });

  it("the bridge escalation option routes through the Twilio REST redirect", async () => {
    const session = createMediaSession(fakeSocket());
    await session.onMessage(startMsg);
    const options = startCallBridge.mock.calls[0][3];
    await options.onEscalate("CA456");
    expect(escalateTwilioCall).toHaveBeenCalledWith("CA456");
  });
});

describe("Twilio media stream token authentication", () => {
  it("valid token → starts the bridge", async () => {
    const session = createMediaSession(fakeSocket());
    await session.onMessage(startFrame());
    expect(startCallBridge).toHaveBeenCalledTimes(1);
  });

  it("missing token → closes the socket without starting a bridge", async () => {
    const socket = fakeSocket();
    const session = createMediaSession(socket);
    const frame = JSON.stringify({
      event: "start",
      streamSid: "MZ123",
      start: { streamSid: "MZ123", callSid: "CA456", customParameters: { from: "+1" } },
    });
    await session.onMessage(frame);
    expect(startCallBridge).not.toHaveBeenCalled();
    expect(socket.closed).toBe(1);
  });

  it("expired token → closes without starting", async () => {
    const socket = fakeSocket();
    const session = createMediaSession(socket);
    // Minted 10 minutes ago with a 5-minute TTL → already expired.
    const past = Math.floor(Date.now() / 1000) - 600;
    const expired = createStreamToken("CA456", AUTH_TOKEN, 300, past);
    await session.onMessage(startFrame({ token: expired }));
    expect(startCallBridge).not.toHaveBeenCalled();
    expect(socket.closed).toBe(1);
  });

  it("tampered token → closes without starting", async () => {
    const socket = fakeSocket();
    const session = createMediaSession(socket);
    const good = createStreamToken("CA456", AUTH_TOKEN);
    const tampered = good.slice(0, -1) + (good.endsWith("a") ? "b" : "a");
    await session.onMessage(startFrame({ token: tampered }));
    expect(startCallBridge).not.toHaveBeenCalled();
    expect(socket.closed).toBe(1);
  });

  it("token bound to a different callSid → closes without starting", async () => {
    const socket = fakeSocket();
    const session = createMediaSession(socket);
    // Valid token for CA999, but the start frame claims CA456.
    const otherToken = createStreamToken("CA999", AUTH_TOKEN);
    await session.onMessage(startFrame({ callSid: "CA456", token: otherToken }));
    expect(startCallBridge).not.toHaveBeenCalled();
    expect(socket.closed).toBe(1);
  });

  it("after a rejected start, a stray stop does not finalize a call", async () => {
    const socket = fakeSocket();
    const session = createMediaSession(socket);
    await session.onMessage(startFrame({ token: "garbage" }));
    await session.onMessage(JSON.stringify({ event: "stop" }));
    expect(endCallBridge).not.toHaveBeenCalled();
    expect(onCallEnded).not.toHaveBeenCalled();
  });

  it("path CallSid matching the start frame → starts the bridge", async () => {
    const socket = fakeSocket();
    const session = createMediaSession(socket, "CA456");
    await session.onMessage(startFrame({ callSid: "CA456" }));
    expect(startCallBridge).toHaveBeenCalledTimes(1);
  });

  it("path CallSid != start-frame CallSid → closes without starting a bridge", async () => {
    const socket = fakeSocket();
    // Connection opened on /media/CA999 but the start frame (with a valid token for
    // CA456) claims CA456 — reject on the path/frame mismatch.
    const session = createMediaSession(socket, "CA999");
    await session.onMessage(startFrame({ callSid: "CA456" }));
    expect(startCallBridge).not.toHaveBeenCalled();
    expect(socket.closed).toBe(1);
  });
});
