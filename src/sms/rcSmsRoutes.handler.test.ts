import { describe, it, expect, vi, beforeEach } from "vitest";

// Deterministic tenant config; mutated per test.
const mockText: any = { enabled: true, number: "+15550001111", rcSmsNumber: "+15550002222" };
let mockRole = "texting";
const mockConfig = { rcSmsWebhookToken: "rc-token" };
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
vi.mock("../twilio/client", () => ({ getTwilioAuthToken: vi.fn(async () => "tw") }));

const handleInboundSms = vi.fn(async () => {});
const sendWebLeadText = vi.fn(async () => true);
vi.mock("./smsService", () => ({
  handleInboundSms: (...a: any[]) => handleInboundSms(...a),
  sendWebLeadText: (...a: any[]) => sendWebLeadText(...a),
}));

import { handleRcSmsWebhook, __resetRcDedupeForTests } from "./smsRoutes";

function fakeReq(opts: {
  headers?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string>;
}) {
  const headers = opts.headers ?? {};
  return {
    header: (name: string) => headers[name],
    body: opts.body ?? {},
    query: opts.query ?? {},
    params: {},
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
    send(payload?: string) {
      this.body = payload ?? "";
      return this;
    },
    set(key: string, value: string) {
      this.headers[key] = value;
      return this;
    },
  };
  return res;
}

function inboundEvent(overrides: Record<string, unknown> = {}) {
  return {
    body: {
      id: "rc-msg-1",
      direction: "Inbound",
      from: { phoneNumber: "+15557778888" },
      to: [{ phoneNumber: "+15550002222" }],
      subject: "hello from RC",
      ...overrides,
    },
  };
}

// Primary auth: the token RC echoes back in the subscription address query string.
// (The Verification-Token / Validation-Token header fallbacks are exercised inline.)
const queryAuth = { token: "rc-token" };

beforeEach(() => {
  vi.clearAllMocks();
  __resetRcDedupeForTests();
  mockText.enabled = true;
  mockText.rcSmsNumber = "+15550002222";
  mockRole = "texting";
  mockConfig.rcSmsWebhookToken = "rc-token";
});

describe("handleRcSmsWebhook — validation handshake", () => {
  it("probe (?token=ok + Validation-Token header + empty body) → 200, echoes header, no processing", async () => {
    const res = fakeRes();
    await handleRcSmsWebhook(fakeReq({ query: queryAuth, headers: { "Validation-Token": "abc123" }, body: {} }), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Validation-Token"]).toBe("abc123");
    expect(handleInboundSms).not.toHaveBeenCalled();
  });
});

describe("handleRcSmsWebhook — fail-closed auth", () => {
  it("503 when RC_SMS_WEBHOOK_TOKEN is unset", async () => {
    mockConfig.rcSmsWebhookToken = "";
    const res = fakeRes();
    await handleRcSmsWebhook(fakeReq({ query: queryAuth, body: inboundEvent() }), res);
    expect(res.statusCode).toBe(503);
    expect(handleInboundSms).not.toHaveBeenCalled();
  });

  it("query token match → processed", async () => {
    const res = fakeRes();
    await handleRcSmsWebhook(fakeReq({ query: queryAuth, body: inboundEvent() }), res);
    expect(res.statusCode).toBe(200);
    expect(handleInboundSms).toHaveBeenCalledTimes(1);
  });

  it("403 on a wrong query token with no matching header", async () => {
    const res = fakeRes();
    await handleRcSmsWebhook(fakeReq({ query: { token: "nope" }, body: inboundEvent() }), res);
    expect(res.statusCode).toBe(403);
    expect(handleInboundSms).not.toHaveBeenCalled();
  });

  it("403 on a missing query token and no matching header", async () => {
    const res = fakeRes();
    await handleRcSmsWebhook(fakeReq({ body: inboundEvent() }), res);
    expect(res.statusCode).toBe(403);
    expect(handleInboundSms).not.toHaveBeenCalled();
  });

  it("header fallback: matching Verification-Token → processed", async () => {
    const res = fakeRes();
    await handleRcSmsWebhook(fakeReq({ headers: { "Verification-Token": "rc-token" }, body: inboundEvent() }), res);
    expect(res.statusCode).toBe(200);
    expect(handleInboundSms).toHaveBeenCalledTimes(1);
  });

  it("header fallback: matching Validation-Token → processed", async () => {
    const res = fakeRes();
    await handleRcSmsWebhook(fakeReq({ headers: { "Validation-Token": "rc-token" }, body: inboundEvent() }), res);
    expect(res.statusCode).toBe(200);
    expect(handleInboundSms).toHaveBeenCalledTimes(1);
  });
});

describe("handleRcSmsWebhook — routing into the shared pipeline", () => {
  it("inbound SMS → handleInboundSms on the ringcentral channel with provider id", async () => {
    const res = fakeRes();
    await handleRcSmsWebhook(fakeReq({ query: queryAuth, body: inboundEvent() }), res);
    expect(res.statusCode).toBe(200);
    expect(handleInboundSms).toHaveBeenCalledWith({
      from: "+15557778888",
      body: "hello from RC",
      channel: "ringcentral",
      providerMessageId: "rc-msg-1",
    });
  });

  it("ignores non-inbound (outbound echo) events", async () => {
    const res = fakeRes();
    await handleRcSmsWebhook(fakeReq({ query: queryAuth, body: inboundEvent({ direction: "Outbound" }) }), res);
    expect(res.statusCode).toBe(200);
    expect(handleInboundSms).not.toHaveBeenCalled();
  });

  it("dedupes a redelivered message id (in-memory LRU) — processes once", async () => {
    const res1 = fakeRes();
    await handleRcSmsWebhook(fakeReq({ query: queryAuth, body: inboundEvent() }), res1);
    const res2 = fakeRes();
    await handleRcSmsWebhook(fakeReq({ query: queryAuth, body: inboundEvent() }), res2);
    expect(res2.statusCode).toBe(200);
    expect(handleInboundSms).toHaveBeenCalledTimes(1);
  });

  it("non-texting role → 200, no pipeline call (role gate)", async () => {
    mockRole = "answer_calls";
    const res = fakeRes();
    await handleRcSmsWebhook(fakeReq({ query: queryAuth, body: inboundEvent() }), res);
    expect(res.statusCode).toBe(200);
    expect(handleInboundSms).not.toHaveBeenCalled();
  });

  it("disabled text bot → 200, no pipeline call", async () => {
    mockText.enabled = false;
    const res = fakeRes();
    await handleRcSmsWebhook(fakeReq({ query: queryAuth, body: inboundEvent() }), res);
    expect(res.statusCode).toBe(200);
    expect(handleInboundSms).not.toHaveBeenCalled();
  });

  it("destination mismatch (to != rc_sms_number) → 200, no pipeline call (fail closed)", async () => {
    const res = fakeRes();
    await handleRcSmsWebhook(
      fakeReq({ query: queryAuth, body: inboundEvent({ to: [{ phoneNumber: "+19998887777" }] }) }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(handleInboundSms).not.toHaveBeenCalled();
  });

  it("unset rc_sms_number → refuses (fail closed), no pipeline call", async () => {
    mockText.rcSmsNumber = undefined;
    const res = fakeRes();
    await handleRcSmsWebhook(fakeReq({ query: queryAuth, body: inboundEvent() }), res);
    expect(res.statusCode).toBe(200);
    expect(handleInboundSms).not.toHaveBeenCalled();
  });

  it("still returns 200 when the pipeline throws", async () => {
    handleInboundSms.mockRejectedValueOnce(new Error("boom"));
    const res = fakeRes();
    await handleRcSmsWebhook(fakeReq({ query: queryAuth, body: inboundEvent() }), res);
    expect(res.statusCode).toBe(200);
  });
});
