import { describe, it, expect, vi, beforeEach } from "vitest";
import twilio from "twilio";

// Mock the config + tenant layers so no network I/O happens and the effective
// Twilio config is deterministic. buildVoiceTwiml (in voiceWebhook.ts) stays real.
const effectiveTwilio = {
  accountSid: "ACtest",
  authToken: "test-auth-token",
  number: "+15550000001",
  voiceProvider: "twilio",
  escalationNumber: "+15559999999",
};
vi.mock("../config", () => ({
  config: { publicBaseUrl: "https://bot.example.com" },
  mediaStreamWssUrl: () => "wss://bot.example.com/twilio/media",
  resolveEffectiveConfig: vi.fn(async () => ({ twilio: effectiveTwilio })),
}));
vi.mock("../db/remoteConfig", () => ({
  loadRemoteConfig: vi.fn(async () => ({ bot: null, botConfig: null, credentials: {} })),
  isBotEnabled: vi.fn(() => true),
}));
vi.mock("./client", () => ({
  getTwilioAuthToken: vi.fn(async () => "test-auth-token"),
}));

import { handleVoiceWebhook } from "./voiceWebhook";
import { isBotEnabled } from "../db/remoteConfig";

function fakeReq(signature: string | undefined, body: Record<string, string>) {
  return {
    header: (name: string) =>
      name === "X-Twilio-Signature" ? signature : undefined,
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

const validParams = { To: "+15550000001", From: "+15557654321" };

beforeEach(() => {
  vi.restoreAllMocks();
  (isBotEnabled as any).mockReturnValue(true);
});

describe("handleVoiceWebhook signature validation (fail-closed)", () => {
  it("rejects with 403 when the signature is invalid", async () => {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(false);
    const res = fakeRes();
    await handleVoiceWebhook(fakeReq("bad-sig", validParams), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("<Connect>");
  });

  it("rejects with 403 when no signature header is present", async () => {
    const spy = vi.spyOn(twilio, "validateRequest").mockReturnValue(false);
    const res = fakeRes();
    await handleVoiceWebhook(fakeReq(undefined, validParams), res);
    expect(res.statusCode).toBe(403);
    // validateRequest is called with an empty signature and returns false.
    expect(spy).toHaveBeenCalled();
  });

  it("proceeds to TwiML (200) when the signature is valid", async () => {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(true);
    const res = fakeRes();
    await handleVoiceWebhook(fakeReq("good-sig", validParams), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/xml");
    expect(res.body).toContain("<Connect>");
    expect(res.body).toContain("<Stream");
  });

  it("valid signature + disabled bot → kill switch dials escalation, no media stream", async () => {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(true);
    (isBotEnabled as any).mockReturnValue(false);
    const res = fakeRes();
    await handleVoiceWebhook(fakeReq("good-sig", validParams), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<Dial>");
    expect(res.body).not.toContain("<Connect>");
  });
});
