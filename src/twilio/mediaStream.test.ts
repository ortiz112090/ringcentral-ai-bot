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

import { createMediaSession, type TwilioSocket } from "./mediaStream";

function fakeSocket(): TwilioSocket & { sent: string[] } {
  const sent: string[] = [];
  return { sent, send: (d: string) => sent.push(d), close: () => {} };
}

const startMsg = JSON.stringify({
  event: "start",
  streamSid: "MZ123",
  start: {
    streamSid: "MZ123",
    callSid: "CA456",
    customParameters: { from: "+15557654321", to: "+15550000001" },
  },
});

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
