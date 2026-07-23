import { describe, it, expect, vi, beforeEach } from "vitest";
import twilio from "twilio";

// Deterministic tenant config; `text`/`mockRole` mutated per test.
const mockText: any = { enabled: true, number: "+15550001111" };
let mockRole = "texting";
const mockConfig = { textOutreachSecret: "s3cret" };
vi.mock("../config", () => ({
  get config() {
    return mockConfig;
  },
  resolveEffectiveConfig: vi.fn(async () => ({ text: mockText, botRole: mockRole })),
  twilioSmsWebhookUrl: () => "https://bot.example.com/webhooks/twilio/sms",
}));
vi.mock("../db/remoteConfig", () => ({
  BOT_ID: "00000000-0000-0000-0000-000000000001",
  loadRemoteConfig: vi.fn(async () => ({ bot: null, botConfig: null, credentials: {} })),
}));
vi.mock("./client", () => ({}));
// smsRoutes now transitively imports the real Supabase client (via velocifySync →
// velocifyQueries), which reads config at module load. Stub it so that import-time
// read doesn't fire the config getter before mockConfig initializes.
vi.mock("../db/supabase", () => ({ supabase: {} }));
vi.mock("../twilio/client", () => ({
  getTwilioAuthToken: vi.fn(async () => "test-auth-token"),
}));

const handleInboundSms = vi.fn(async () => {});
const sendWebLeadText = vi.fn(async () => true);
vi.mock("./smsService", () => ({
  handleInboundSms: (...a: any[]) => handleInboundSms(...a),
  sendWebLeadText: (...a: any[]) => sendWebLeadText(...a),
}));

import { handleSmsWebhook, handleTextOutreach } from "./smsRoutes";
import { loadRemoteConfig } from "../db/remoteConfig";
import { resolveEffectiveConfig } from "../config";

function fakeReq(opts: {
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  params?: Record<string, string>;
}) {
  const headers = opts.headers ?? {};
  return {
    header: (name: string) => headers[name],
    body: opts.body ?? {},
    params: opts.params ?? {},
  } as any;
}

function fakeRes() {
  const res: any = {
    statusCode: 0,
    body: "",
    jsonBody: undefined,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: string) {
      this.body = payload;
      return this;
    },
    json(payload: unknown) {
      this.jsonBody = payload;
      return this;
    },
    set(key: string, value: string) {
      this.headers[key] = value;
      return this;
    },
  };
  return res;
}

const validSmsParams = { To: "+15550001111", From: "+15557778888", Body: "hello" };

beforeEach(() => {
  vi.clearAllMocks();
  mockText.enabled = true;
  mockText.number = "+15550001111";
  mockRole = "texting";
  mockConfig.textOutreachSecret = "s3cret";
});

describe("handleSmsWebhook", () => {
  it("rejects 403 on an invalid signature and never touches the service", async () => {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(false);
    const res = fakeRes();
    await handleSmsWebhook(fakeReq({ headers: { "X-Twilio-Signature": "bad" }, body: validSmsParams }), res);
    expect(res.statusCode).toBe(403);
    expect(handleInboundSms).not.toHaveBeenCalled();
  });

  it("disabled text bot → empty TwiML, no service call", async () => {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(true);
    mockText.enabled = false;
    const res = fakeRes();
    await handleSmsWebhook(fakeReq({ headers: { "X-Twilio-Signature": "ok" }, body: validSmsParams }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<Response");
    expect(handleInboundSms).not.toHaveBeenCalled();
  });

  it("To does not match the tenant number → empty TwiML, no service call", async () => {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(true);
    const res = fakeRes();
    await handleSmsWebhook(
      fakeReq({ headers: { "X-Twilio-Signature": "ok" }, body: { ...validSmsParams, To: "+15559999999" } }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(handleInboundSms).not.toHaveBeenCalled();
  });

  it("non-texting role → empty TwiML, no service call (role gate)", async () => {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(true);
    mockRole = "answer_calls";
    const res = fakeRes();
    await handleSmsWebhook(fakeReq({ headers: { "X-Twilio-Signature": "ok" }, body: validSmsParams }), res);
    expect(res.statusCode).toBe(200);
    expect(handleInboundSms).not.toHaveBeenCalled();
  });

  it("valid signature + matching To → calls handleInboundSms and returns empty TwiML", async () => {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(true);
    const res = fakeRes();
    await handleSmsWebhook(fakeReq({ headers: { "X-Twilio-Signature": "ok" }, body: validSmsParams }), res);
    expect(handleInboundSms).toHaveBeenCalledWith({ from: "+15557778888", body: "hello" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/xml");
  });

  it("swallows a service throw and still returns 200 empty TwiML", async () => {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(true);
    handleInboundSms.mockRejectedValueOnce(new Error("boom"));
    const res = fakeRes();
    await handleSmsWebhook(fakeReq({ headers: { "X-Twilio-Signature": "ok" }, body: validSmsParams }), res);
    expect(res.statusCode).toBe(200);
  });
});

describe("handleTextOutreach (shared-secret auth)", () => {
  const auth = { "X-Outreach-Secret": "s3cret" };
  const botParams = { botId: "00000000-0000-0000-0000-000000000001" };

  it("503 when no TEXT_OUTREACH_SECRET is configured", async () => {
    mockConfig.textOutreachSecret = "";
    const res = fakeRes();
    await handleTextOutreach(fakeReq({ headers: auth, body: { phone: "+15557778888" }, params: botParams }), res);
    expect(res.statusCode).toBe(503);
    expect(sendWebLeadText).not.toHaveBeenCalled();
  });

  it("401 on a missing/wrong secret", async () => {
    const res = fakeRes();
    await handleTextOutreach(
      fakeReq({ headers: { "X-Outreach-Secret": "wrong" }, body: { phone: "+15557778888" }, params: botParams }),
      res
    );
    expect(res.statusCode).toBe(401);
    expect(sendWebLeadText).not.toHaveBeenCalled();
  });

  it("404 when the path botId does not match this tenant", async () => {
    const res = fakeRes();
    await handleTextOutreach(
      fakeReq({ headers: auth, body: { phone: "+15557778888" }, params: { botId: "other" } }),
      res
    );
    expect(res.statusCode).toBe(404);
  });

  it("400 when phone is missing", async () => {
    const res = fakeRes();
    await handleTextOutreach(fakeReq({ headers: auth, body: {}, params: botParams }), res);
    expect(res.statusCode).toBe(400);
    expect(sendWebLeadText).not.toHaveBeenCalled();
  });

  it("403 when the tenant role does not allow SMS", async () => {
    mockRole = "answer_calls";
    const res = fakeRes();
    await handleTextOutreach(
      fakeReq({ headers: auth, body: { phone: "+15557778888" }, params: botParams }),
      res
    );
    expect(res.statusCode).toBe(403);
    expect(sendWebLeadText).not.toHaveBeenCalled();
  });

  it("refreshes remote config before resolving effective config (fresh per call)", async () => {
    const res = fakeRes();
    await handleTextOutreach(
      fakeReq({ headers: auth, body: { phone: "+15557778888" }, params: botParams }),
      res
    );
    expect(loadRemoteConfig).toHaveBeenCalled();
    const loadOrder = (loadRemoteConfig as any).mock.invocationCallOrder[0];
    const resolveOrder = (resolveEffectiveConfig as any).mock.invocationCallOrder[0];
    expect(loadOrder).toBeLessThan(resolveOrder);
  });

  it("202 and fires the web-lead outreach on a valid authenticated request", async () => {
    const res = fakeRes();
    await handleTextOutreach(
      fakeReq({ headers: auth, body: { phone: "+15557778888", name: "Dana" }, params: botParams }),
      res
    );
    expect(res.statusCode).toBe(202);
    expect(sendWebLeadText).toHaveBeenCalledWith({ phone: "+15557778888", name: "Dana" });
    expect(res.jsonBody).toMatchObject({ accepted: true, sent: true });
  });
});
