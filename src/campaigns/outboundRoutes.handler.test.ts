import { describe, it, expect, vi, beforeEach } from "vitest";
import twilio from "twilio";

const effectiveTwilio = {
  accountSid: "ACtest",
  authToken: "test-auth-token",
  number: "+15550000001",
  voiceProvider: "twilio",
  escalationNumber: "+15559999999",
};
vi.mock("../config", () => ({
  mediaStreamWssUrl: (callSid: string) => `wss://bot.example.com/media/${callSid}`,
  twilioVoiceOutboundWebhookUrl: (contactId: number | string) =>
    `https://bot.example.com/webhooks/twilio/voice-outbound?contactId=${contactId}`,
  resolveEffectiveConfig: vi.fn(async () => ({ twilio: effectiveTwilio, botRole: "outbound_calls" })),
}));
vi.mock("../db/remoteConfig", () => ({
  BOT_ID: "00000000-0000-0000-0000-000000000001",
  loadRemoteConfig: vi.fn(async () => ({ bot: null, botConfig: null, credentials: {} })),
}));
vi.mock("../twilio/client", () => ({
  getTwilioAuthToken: vi.fn(async () => "test-auth-token"),
}));
const createCallRecord = vi.fn(async () => {});
vi.mock("../db/queries", () => ({
  createCallRecord: (...a: any[]) => createCallRecord(...a),
}));
const setContactCallOutcome = vi.fn(async () => {});
vi.mock("./campaignQueries", () => ({
  setContactCallOutcome: (...a: any[]) => setContactCallOutcome(...a),
}));

import {
  handleOutboundVoiceWebhook,
  isMachineAnswer,
  buildOutboundStreamTwiml,
} from "./outboundRoutes";
import { registerOutboundCall, isOutboundCall, clearOutboundCalls } from "./outboundState";

function fakeReq(
  signature: string | undefined,
  body: Record<string, string>,
  contactId?: string
) {
  return {
    header: (name: string) => (name === "X-Twilio-Signature" ? signature : undefined),
    body,
    query: { contactId },
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

const humanParams = { CallSid: "CA_out_1", To: "+15551234567", From: "+15550000001" };

beforeEach(() => {
  vi.clearAllMocks();
  clearOutboundCalls();
});

describe("isMachineAnswer", () => {
  it("treats machine_* and fax as a machine", () => {
    expect(isMachineAnswer("machine_start")).toBe(true);
    expect(isMachineAnswer("machine_end_beep")).toBe(true);
    expect(isMachineAnswer("fax")).toBe(true);
    expect(isMachineAnswer("MACHINE_START")).toBe(true);
  });

  it("treats human/unknown/absent as NOT a machine", () => {
    expect(isMachineAnswer("human")).toBe(false);
    expect(isMachineAnswer("unknown")).toBe(false);
    expect(isMachineAnswer("")).toBe(false);
    expect(isMachineAnswer(null)).toBe(false);
    expect(isMachineAnswer(undefined)).toBe(false);
  });
});

describe("buildOutboundStreamTwiml", () => {
  it("hangs up when it cannot bridge (no wss URL)", () => {
    const xml = buildOutboundStreamTwiml({
      callSid: "CA1",
      leadNumber: "+15551234567",
      twilioNumber: "+15550000001",
      wssUrl: "",
      authToken: "tok",
    });
    expect(xml).toContain("<Hangup");
    expect(xml).not.toContain("<Connect>");
  });
});

describe("handleOutboundVoiceWebhook signature validation (fail-closed)", () => {
  it("rejects with 403 when the signature is invalid", async () => {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(false);
    const res = fakeRes();
    await handleOutboundVoiceWebhook(fakeReq("bad", humanParams, "5"), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("<Connect>");
    expect(createCallRecord).not.toHaveBeenCalled();
  });

  it("rejects with 403 when no signature header is present", async () => {
    const spy = vi.spyOn(twilio, "validateRequest").mockReturnValue(false);
    const res = fakeRes();
    await handleOutboundVoiceWebhook(fakeReq(undefined, humanParams, "5"), res);
    expect(res.statusCode).toBe(403);
    expect(spy).toHaveBeenCalled();
  });
});

describe("handleOutboundVoiceWebhook machine detection", () => {
  beforeEach(() => {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(true);
  });

  it("machine answer → Hangup, no stream, no call row, contact marked failed", async () => {
    registerOutboundCall("CA_out_1", 5, "camp-1");
    const res = fakeRes();
    await handleOutboundVoiceWebhook(
      fakeReq("ok", { ...humanParams, AnsweredBy: "machine_start" }, "5"),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<Hangup");
    expect(res.body).not.toContain("<Connect>");
    expect(createCallRecord).not.toHaveBeenCalled();
    expect(setContactCallOutcome).toHaveBeenCalledWith(
      5,
      "failed",
      "answering_machine:machine_start",
      "CA_out_1"
    );
    // registry entry removed so the later 'completed' callback no-ops.
    expect(isOutboundCall("CA_out_1")).toBe(false);
  });
});

describe("handleOutboundVoiceWebhook human answer", () => {
  beforeEach(() => {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(true);
  });

  it("human answer → Connect/Stream to the per-call bridge with a signed token", async () => {
    const res = fakeRes();
    await handleOutboundVoiceWebhook(fakeReq("ok", { ...humanParams, AnsweredBy: "human" }, "5"), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/xml");
    expect(res.body).toContain("<Connect>");
    expect(res.body).toContain('<Stream url="wss://bot.example.com/media/CA_out_1">');
    expect(res.body).toMatch(/name="token" value="\d+\.[0-9a-f]+"/);
  });

  it("human answer → phase-1 INSERT of the outbound call row linked to its contact", async () => {
    const res = fakeRes();
    await handleOutboundVoiceWebhook(fakeReq("ok", { ...humanParams, AnsweredBy: "human" }, "5"), res);
    expect(createCallRecord).toHaveBeenCalledTimes(1);
    const record = createCallRecord.mock.calls[0][0];
    expect(record.call_id).toBe("CA_out_1");
    expect(record.direction).toBe("outbound");
    expect(record.campaign_contact_id).toBe(5);
    expect(record.caller_number).toBe("+15551234567");
  });

  it("absent AnsweredBy (unknown) → still bridges the call", async () => {
    const res = fakeRes();
    await handleOutboundVoiceWebhook(fakeReq("ok", humanParams, "5"), res);
    expect(res.body).toContain("<Connect>");
    expect(res.body).toContain("<Stream");
  });
});
