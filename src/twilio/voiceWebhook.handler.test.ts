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
vi.mock("../config", () => ({
  mediaStreamWssUrl: (callSid: string) => `wss://bot.example.com/media/${callSid}`,
  twilioVoiceWebhookUrl: () => "https://bot.example.com/webhooks/twilio/voice",
  twilioStatusCallbackUrl: () => "https://bot.example.com/webhooks/twilio/status",
  resolveEffectiveConfig: vi.fn(async () => ({ twilio: effectiveTwilio })),
}));
vi.mock("../db/remoteConfig", () => ({
  loadRemoteConfig: vi.fn(async () => ({ bot: null, botConfig: null, credentials: {} })),
  isBotEnabled: vi.fn(() => true),
}));
vi.mock("./client", () => ({
  getTwilioAuthToken: vi.fn(async () => "test-auth-token"),
}));
const createCallRecord = vi.fn(async () => {});
const closeCallIfLive = vi.fn(async () => {});
vi.mock("../db/queries", () => ({
  createCallRecord: (...a: any[]) => createCallRecord(...a),
  closeCallIfLive: (...a: any[]) => closeCallIfLive(...a),
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
