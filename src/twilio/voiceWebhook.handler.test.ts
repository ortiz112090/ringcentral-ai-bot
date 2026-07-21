import { describe, it, expect, vi, beforeEach } from "vitest";
import twilio from "twilio";

// Mock the config + tenant + DB layers so no network I/O happens and the effective
// Twilio config is deterministic. buildVoiceTwiml (in voiceWebhook.ts) stays real.
const effectiveTwilio = {
  accountSid: "ACtest",
  authToken: "test-auth-token",
  number: "+15550000001",
  voiceProvider: "twilio",
  escalationNumber: "+15559999999",
};
let mockRole = "answer_calls";
vi.mock("../config", () => ({
  mediaStreamWssUrl: (callSid: string) => `wss://bot.example.com/media/${callSid}`,
  twilioVoiceWebhookUrl: () => "https://bot.example.com/webhooks/twilio/voice",
  twilioStatusCallbackUrl: () => "https://bot.example.com/webhooks/twilio/status",
  resolveEffectiveConfig: vi.fn(async () => ({ twilio: effectiveTwilio, botRole: mockRole })),
}));
vi.mock("../db/remoteConfig", () => ({
  BOT_ID: "00000000-0000-0000-0000-000000000001",
  loadRemoteConfig: vi.fn(async () => ({ bot: null, botConfig: null, credentials: {} })),
  isBotEnabled: vi.fn(() => true),
}));
vi.mock("./client", () => ({
  getTwilioAuthToken: vi.fn(async () => "test-auth-token"),
}));
const createCallRecord = vi.fn(async () => {});
const closeCallIfLive = vi.fn(async () => {});
const fetchBotActiveStatus = vi.fn(async () => ({ found: true, active: true, deleted_at: null }));
vi.mock("../db/queries", () => ({
  createCallRecord: (...a: any[]) => createCallRecord(...a),
  closeCallIfLive: (...a: any[]) => closeCallIfLive(...a),
  fetchBotActiveStatus: (...a: any[]) => fetchBotActiveStatus(...a),
}));

import { handleVoiceWebhook, handleStatusCallback } from "./voiceWebhook";
import { isBotEnabled } from "../db/remoteConfig";

function fakeReq(signature: string | undefined, body: Record<string, string>) {
  return {
    header: (name: string) => (name === "X-Twilio-Signature" ? signature : undefined),
    body,
  } as any;
}

function fakeRes() {
  const res: any = {
    statusCode: 0,
    body: "",
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: string) {
      this.body = payload;
      return this;
    },
    set(key: string, value: string) {
      this.headers[key] = value;
      return this;
    },
  };
  return res;
}

const validParams = { CallSid: "CA456", To: "+15550000001", From: "+15557654321" };

beforeEach(() => {
  vi.clearAllMocks();
  (isBotEnabled as any).mockReturnValue(true);
  mockRole = "answer_calls";
  fetchBotActiveStatus.mockResolvedValue({ found: true, active: true, deleted_at: null });
});

describe("handleVoiceWebhook signature validation (fail-closed)", () => {
  it("rejects with 403 when the signature is invalid", async () => {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(false);
    const res = fakeRes();
    await handleVoiceWebhook(fakeReq("bad-sig", validParams), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("<Connect>");
    expect(createCallRecord).not.toHaveBeenCalled();
  });

  it("rejects with 403 when no signature header is present", async () => {
    const spy = vi.spyOn(twilio, "validateRequest").mockReturnValue(false);
    const res = fakeRes();
    await handleVoiceWebhook(fakeReq(undefined, validParams), res);
    expect(res.statusCode).toBe(403);
    expect(spy).toHaveBeenCalled();
  });

  it("valid signature → Connect/Stream to the per-call wss URL with a signed token", async () => {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(true);
    const res = fakeRes();
    await handleVoiceWebhook(fakeReq("good-sig", validParams), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/xml");
    expect(res.body).toContain("<Connect>");
    expect(res.body).toContain('<Stream url="wss://bot.example.com/media/CA456">');
    expect(res.body).toMatch(/name="token" value="\d+\.[0-9a-f]+"/);
  });

  it("valid answered call → phase-1 INSERT of the two-phase call row", async () => {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(true);
    await handleVoiceWebhook(fakeReq("good-sig", validParams), fakeRes());
    expect(createCallRecord).toHaveBeenCalledTimes(1);
    const record = createCallRecord.mock.calls[0][0];
    expect(record.call_id).toBe("CA456");
    expect(record.caller_number).toBe("+15557654321");
  });

  it("RC-forwarded call → stores the ORIGINAL caller (ForwardedFrom), not the forwarder", async () => {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(true);
    const res = fakeRes();
    await handleVoiceWebhook(
      fakeReq("good-sig", {
        CallSid: "CA789",
        To: "+15550000001",
        From: "+15550000001", // forwarding (RC) number
        ForwardedFrom: "+15551112222", // original lead
      }),
      res
    );
    expect(res.body).toContain('value="+15551112222"');
    expect(createCallRecord.mock.calls[0][0].caller_number).toBe("+15551112222");
  });

  it("valid signature + disabled bot → kill-switch fallback, no bridge, no INSERT", async () => {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(true);
    (isBotEnabled as any).mockReturnValue(false);
    const res = fakeRes();
    await handleVoiceWebhook(fakeReq("good-sig", validParams), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<Dial>");
    expect(res.body).not.toContain("<Connect>");
    expect(createCallRecord).not.toHaveBeenCalled();
  });

  it("texting-role bot → polite reject TwiML, no bridge, no INSERT", async () => {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(true);
    mockRole = "texting";
    const res = fakeRes();
    await handleVoiceWebhook(fakeReq("good-sig", validParams), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<Say");
    expect(res.body).toContain("<Hangup");
    expect(res.body).not.toContain("<Connect>");
    expect(createCallRecord).not.toHaveBeenCalled();
  });

  it("outbound_calls role → inbound call still answers (Connect/Stream) for callbacks", async () => {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(true);
    mockRole = "outbound_calls";
    const res = fakeRes();
    await handleVoiceWebhook(fakeReq("good-sig", validParams), res);
    expect(res.body).toContain("<Connect>");
    expect(res.body).toContain("<Stream");
  });

  it("valid signature + To mismatch → fallback, logged, no INSERT", async () => {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(true);
    const res = fakeRes();
    await handleVoiceWebhook(
      fakeReq("good-sig", { ...validParams, To: "+15550000999" }),
      res
    );
    expect(res.body).not.toContain("<Connect>");
    expect(createCallRecord).not.toHaveBeenCalled();
  });
});

describe("handleVoiceWebhook bots.active gate (fresh per-call read)", () => {
  beforeEach(() => {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(true);
  });

  it("active bot → unchanged answer TwiML (Connect/Stream), calls row INSERTed", async () => {
    fetchBotActiveStatus.mockResolvedValue({ found: true, active: true, deleted_at: null });
    const res = fakeRes();
    await handleVoiceWebhook(fakeReq("good-sig", validParams), res);
    expect(res.body).toContain("<Connect>");
    expect(res.body).toContain("<Stream");
    expect(createCallRecord).toHaveBeenCalledTimes(1);
  });

  it("inactive bot + escalation number → <Dial> with the number, no calls row, no stream", async () => {
    fetchBotActiveStatus.mockResolvedValue({ found: true, active: false, deleted_at: null });
    const res = fakeRes();
    await handleVoiceWebhook(fakeReq("good-sig", validParams), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<Dial>+15559999999</Dial>");
    expect(res.body).not.toContain("<Connect>");
    expect(res.body).not.toContain("<Stream");
    expect(createCallRecord).not.toHaveBeenCalled();
  });

  it("inactive bot + no escalation number → <Reject/>, no calls row", async () => {
    effectiveTwilio.escalationNumber = "";
    fetchBotActiveStatus.mockResolvedValue({ found: true, active: false, deleted_at: null });
    const res = fakeRes();
    try {
      await handleVoiceWebhook(fakeReq("good-sig", validParams), res);
      expect(res.body).toContain("<Reject");
      expect(res.body).not.toContain("<Dial>");
      expect(res.body).not.toContain("<Connect>");
      expect(createCallRecord).not.toHaveBeenCalled();
    } finally {
      effectiveTwilio.escalationNumber = "+15559999999";
    }
  });

  it("missing bots row → treated as disabled (forwarded), no calls row", async () => {
    fetchBotActiveStatus.mockResolvedValue({ found: false, active: null, deleted_at: null });
    const res = fakeRes();
    await handleVoiceWebhook(fakeReq("good-sig", validParams), res);
    expect(res.body).toContain("<Dial>+15559999999</Dial>");
    expect(createCallRecord).not.toHaveBeenCalled();
  });

  it("trashed bot (deleted_at set) → treated as disabled (forwarded)", async () => {
    fetchBotActiveStatus.mockResolvedValue({
      found: true,
      active: true,
      deleted_at: "2026-07-20T00:00:00Z",
    });
    const res = fakeRes();
    await handleVoiceWebhook(fakeReq("good-sig", validParams), res);
    expect(res.body).toContain("<Dial>+15559999999</Dial>");
    expect(createCallRecord).not.toHaveBeenCalled();
  });

  it("fresh read: flipping active between two webhook calls changes behavior (no restart)", async () => {
    // First call: active → answers with a media stream.
    fetchBotActiveStatus.mockResolvedValueOnce({ found: true, active: true, deleted_at: null });
    const first = fakeRes();
    await handleVoiceWebhook(fakeReq("good-sig", validParams), first);
    expect(first.body).toContain("<Stream");

    // Second call: flipped to inactive in the DB → forwards, no stream.
    fetchBotActiveStatus.mockResolvedValueOnce({ found: true, active: false, deleted_at: null });
    const second = fakeRes();
    await handleVoiceWebhook(fakeReq("good-sig", validParams), second);
    expect(second.body).not.toContain("<Stream");
    expect(second.body).toContain("<Dial>+15559999999</Dial>");
  });
});

describe("handleStatusCallback (call-row backstop)", () => {
  it("rejects 403 on invalid signature", async () => {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(false);
    const res = fakeRes();
    await handleStatusCallback(fakeReq("bad", { CallSid: "CA456", CallStatus: "completed" }), res);
    expect(res.statusCode).toBe(403);
    expect(closeCallIfLive).not.toHaveBeenCalled();
  });

  it("closes the live row on a terminal 'completed' status", async () => {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(true);
    const res = fakeRes();
    await handleStatusCallback(fakeReq("ok", { CallSid: "CA456", CallStatus: "completed" }), res);
    expect(res.statusCode).toBe(204);
    expect(closeCallIfLive).toHaveBeenCalledWith("CA456", "abandoned");
  });

  it("ignores non-terminal statuses (e.g. 'ringing')", async () => {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(true);
    const res = fakeRes();
    await handleStatusCallback(fakeReq("ok", { CallSid: "CA456", CallStatus: "ringing" }), res);
    expect(res.statusCode).toBe(204);
    expect(closeCallIfLive).not.toHaveBeenCalled();
  });
});
